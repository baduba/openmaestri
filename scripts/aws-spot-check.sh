#!/usr/bin/env bash
# A small Spot instance kept for a while as a test box, reached through SSM (no inbound port, no SSH key).
#
#   aws-spot-check.sh up          create the box (role, security group, persistent Spot instance)
#   aws-spot-check.sh ready       wait until the box answers through SSM
#   aws-spot-check.sh run CMD     run CMD on the box as the user "omtest" (OM_AS_ROOT=1 for root) and print the output
#   aws-spot-check.sh stop        stop the box (it keeps its disk, you pay only for the disk)
#   aws-spot-check.sh start       start it again
#   aws-spot-check.sh status      what is recorded, what exists, when it should be reviewed
#   aws-spot-check.sh down        delete exactly what "up" created, nothing else
#   aws-spot-check.sh userdata    print the script the box runs on first boot (review it before 'up')
#
# Credentials come from the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) or a profile
# (AWS_PROFILE); they are never written anywhere. Settings (all optional):
#   OM_REGION     region (default us-east-1). Pick one whose default VPC runs no production.
#   OM_TYPE       instance type (default t3.medium)
#   OM_REVIEW_DAYS  days until the box should be reviewed and probably destroyed (default 14)
#   OM_STATE      state file (default ~/.local/state/openmaestri/aws-box.env)
#
# Safety rules, in the order they matter:
#   1. Everything created carries the tag Project=openmaestri-sandbox-test and a ReviewBy date.
#   2. "down" only touches the IDs written to the state file, and for each one first checks the tag,
#      the account, the region and the VPC. It never deletes by tag filter, wildcard or name.
#   3. No inbound rule exists. The only IAM thing created is one role that can do what SSM needs.
set -euo pipefail

REGION="${OM_REGION:-us-east-1}"
TYPE="${OM_TYPE:-t3.medium}"
DAYS="${OM_REVIEW_DAYS:-14}"
STATE="${OM_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/openmaestri/aws-box.env}"
TAG_KEY=Project
TAG_VAL=openmaestri-sandbox-test
SSM_POLICY=arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
export AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

die() { echo "error: $*" >&2; exit 1; }
aws_() { aws --region "$REGION" "$@"; }
need() { command -v "$1" >/dev/null || die "$1 is required"; }
need aws
need python3

load_state() {
  [ -f "$STATE" ] || die "no state file at $STATE (nothing was created, or it was already cleaned)"
  set -a
  # shellcheck source=/dev/null
  . "$STATE"
  set +a
  [ "$OM_REGION" = "$REGION" ] || die "state was made in $OM_REGION, but OM_REGION is $REGION"
}

save() { # NAME VALUE: add or replace one line of the state file
  mkdir -p "$(dirname "$STATE")"
  touch "$STATE"
  grep -v "^$1=" "$STATE" > "$STATE.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}

user_data() {
  cat <<'EOF'
#!/bin/bash
exec > >(tee /var/log/om-bootstrap.log | logger -t om-bootstrap -s 2>/dev/console) 2>&1
set -u
export DEBIAN_FRONTEND=noninteractive
say() { echo "OM-REPORT $*" > /dev/console; }
step() { local n="$1"; shift; local t0; t0=$(date +%s); if "$@" >>/var/log/om-steps.log 2>&1; then say "STEP $n: PASS ($(($(date +%s)-t0))s)"; else say "STEP $n: FAIL ($(($(date +%s)-t0))s)"; tail -n 6 /var/log/om-steps.log | cut -c1-200 | while IFS= read -r l; do say "  log: $l"; done; return 1; fi; }
say "BEGIN $(date -u +%FT%TZ)"
step apt-install bash -c 'apt-get update -qq && apt-get install -y -qq docker.io git tmux xz-utils curl ca-certificates dpkg build-essential python3 unzip' || { say END; exit 1; }
step docker-start systemctl enable --now docker
install_node() {
  base=https://nodejs.org/dist/latest-v22.x
  f=$(curl -fsSL $base/SHASUMS256.txt | awk '/linux-x64.tar.xz/{print $2}')
  cd /tmp && curl -fsSLO $base/$f && curl -fsSL $base/SHASUMS256.txt | grep " $f\$" | sha256sum -c - && tar -xJf $f -C /usr/local --strip-components=1
}
step node-install install_node
id omtest >/dev/null 2>&1 || useradd -m -s /bin/bash omtest
usermod -aG docker omtest
step docker-pull-alpine docker pull -q alpine:3
say "versions: node $(node -v) | npm $(npm -v) | $(docker --version) | $(tmux -V)"
say "END $(date -u +%FT%TZ)"
EOF
}

tags() { echo "{Key=$TAG_KEY,Value=$TAG_VAL},{Key=CreatedBy,Value=claude-code},{Key=Purpose,Value=temporary-test-box},{Key=ReviewBy,Value=$1}"; }

cmd_up() {
  [ ! -f "$STATE" ] || die "a state file already exists ($STATE): run 'down' first, or 'status' to see the box"
  local acct vpc subnet ami before review role sg out
  acct=$(aws_ sts get-caller-identity --query Account --output text)
  vpc=$(aws_ ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
  [ "$vpc" != None ] || die "no default VPC in $REGION"
  # refuse a VPC that already runs another workload: the point is to stay away from production
  before=$(aws_ ec2 describe-instances --filters "Name=vpc-id,Values=$vpc" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'length(Reservations[].Instances[])' --output text)
  [ "$before" = 0 ] || die "the default VPC $vpc in $REGION has $before instances; pick another region with OM_REGION"
  subnet=$(aws_ ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" "Name=default-for-az,Values=true" --query 'Subnets[0].SubnetId' --output text)
  ami=$(aws_ ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
  review=$(date -d "+$DAYS days" +%F)
  echo "account $acct, region $REGION, vpc $vpc (empty), subnet $subnet, ami $ami, type $TYPE, review by $review"
  save OM_REGION "$REGION"; save OM_ACCOUNT "$acct"; save OM_VPC "$vpc"; save OM_REVIEW_BY "$review"

  # one role, only what the SSM agent needs; it lets us run commands without an open port
  role="om-spot-box-$(date +%s)"
  aws_ iam create-role --role-name "$role" --description "temporary test box, SSM only" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=ReviewBy,Value=$review" --query Role.RoleName --output text >/dev/null
  save OM_ROLE "$role"
  aws_ iam attach-role-policy --role-name "$role" --policy-arn "$SSM_POLICY"
  aws_ iam create-instance-profile --instance-profile-name "$role" --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=ReviewBy,Value=$review" >/dev/null
  aws_ iam add-role-to-instance-profile --instance-profile-name "$role" --role-name "$role"

  sg=$(aws_ ec2 create-security-group --group-name "om-spot-box-$(date +%s)" --description "test box, no inbound" --vpc-id "$vpc" \
    --tag-specifications "ResourceType=security-group,Tags=[$(tags "$review")]" --query GroupId --output text)
  save OM_SG "$sg"
  # the default egress rule stays (the box downloads packages); there is no inbound rule at all
  local try
  for try in 1 2 3 4 5 6; do
    if out=$(aws_ ec2 run-instances --image-id "$ami" --instance-type "$TYPE" --subnet-id "$subnet" --security-group-ids "$sg" \
      --iam-instance-profile "Name=$role" \
      --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=persistent,InstanceInterruptionBehavior=stop}' \
      --metadata-options HttpTokens=required,HttpEndpoint=enabled \
      --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
      --tag-specifications "ResourceType=instance,Tags=[$(tags "$review"),{Key=Name,Value=om-spot-box}]" "ResourceType=volume,Tags=[$(tags "$review")]" \
      --user-data "$(user_data)" --query 'Instances[0].[InstanceId,SpotInstanceRequestId]' --output text 2>&1); then break; fi
    # a brand new instance profile takes a few seconds to be visible
    echo "$out" | grep -qi 'instance profile' || die "$out"
    sleep 10
  done
  case "$out" in i-*) ;; *) die "could not create the instance: $out" ;; esac
  save OM_INSTANCE "$(echo "$out" | cut -f1)"; save OM_SPOT_REQUEST "$(echo "$out" | cut -f2)"
  echo "created:"; cat "$STATE"
}

cmd_ready() {
  load_state
  local ping _
  for _ in $(seq 1 60); do
    ping=$(aws_ ssm describe-instance-information --filters "Key=InstanceIds,Values=$OM_INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)
    [ "$ping" = Online ] && { echo "online"; return 0; }
    sleep 10
  done
  die "the box did not register with SSM in 10 minutes"
}

cmd_run() {
  load_state
  [ $# -gt 0 ] || die "give a command: run 'cd openmaestri && npm test'"
  local file id status
  file=$(mktemp)
  python3 - "$file" "$*" <<'PY'
import json, shlex, sys
out, cmd = sys.argv[1], sys.argv[2]
import os
line = cmd if os.environ.get("OM_AS_ROOT") == "1" else "su - omtest -c " + shlex.quote(cmd)
json.dump({"commands": [line], "executionTimeout": ["3600"]}, open(out, "w"))
PY
  id=$(aws_ ssm send-command --instance-ids "$OM_INSTANCE" --document-name AWS-RunShellScript --parameters "file://$file" --query Command.CommandId --output text)
  rm -f "$file"
  while :; do
    status=$(aws_ ssm get-command-invocation --command-id "$id" --instance-id "$OM_INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in Pending|InProgress|Delayed) sleep 5 ;; *) break ;; esac
  done
  aws_ ssm get-command-invocation --command-id "$id" --instance-id "$OM_INSTANCE" --query StandardOutputContent --output text
  aws_ ssm get-command-invocation --command-id "$id" --instance-id "$OM_INSTANCE" --query StandardErrorContent --output text >&2
  echo "[status: $status]"
  [ "$status" = Success ]
}

cmd_stop() { load_state; aws_ ec2 stop-instances --instance-ids "$OM_INSTANCE" --query 'StoppingInstances[0].CurrentState.Name' --output text; aws_ ec2 wait instance-stopped --instance-ids "$OM_INSTANCE"; echo stopped; }
cmd_start() {
  load_state
  # right after a stop the persistent Spot request is still "marked-for-stop"; it must reach "disabled" first
  local st _
  for _ in $(seq 1 30); do
    st=$(aws_ ec2 describe-spot-instance-requests --spot-instance-request-ids "$OM_SPOT_REQUEST" --query 'SpotInstanceRequests[0].Status.Code' --output text)
    [ "$st" = marked-for-stop ] || break
    sleep 10
  done
  echo "spot request: $st"
  aws_ ec2 start-instances --instance-ids "$OM_INSTANCE" --query 'StartingInstances[0].CurrentState.Name' --output text
  aws_ ec2 wait instance-running --instance-ids "$OM_INSTANCE"
  cmd_ready
}

# Refuse unless this exact resource carries our tag, so a wrong ID in the state file can do no harm.
check_tag() { # kind id
  local v
  case "$1" in
    instance) v=$(aws_ ec2 describe-instances --instance-ids "$2" --query "Reservations[0].Instances[0].Tags[?Key=='$TAG_KEY']|[0].Value" --output text) ;;
    sg) v=$(aws_ ec2 describe-security-groups --group-ids "$2" --query "SecurityGroups[0].Tags[?Key=='$TAG_KEY']|[0].Value" --output text) ;;
    role) v=$(aws_ iam get-role --role-name "$2" --query "Role.Tags[?Key=='$TAG_KEY']|[0].Value" --output text) ;;
    profile) v=$(aws_ iam get-instance-profile --instance-profile-name "$2" --query "InstanceProfile.Tags[?Key=='$TAG_KEY']|[0].Value" --output text) ;;
    *) die "unknown kind $1" ;;
  esac
  [ "$v" = "$TAG_VAL" ] || die "$1 $2 does not carry $TAG_KEY=$TAG_VAL (found '$v'); NOT touching it"
}

cmd_down() {
  load_state
  local acct
  acct=$(aws_ sts get-caller-identity --query Account --output text)
  [ "$acct" = "$OM_ACCOUNT" ] || die "state belongs to account $OM_ACCOUNT, you are in $acct"
  # check everything first: if any tag or VPC is wrong, nothing at all is touched
  [ -z "${OM_INSTANCE:-}" ] || { check_tag instance "$OM_INSTANCE"; [ "$(aws_ ec2 describe-instances --instance-ids "$OM_INSTANCE" --query 'Reservations[0].Instances[0].VpcId' --output text)" = "$OM_VPC" ] || die "instance is not in $OM_VPC; NOT touching anything"; }
  [ -z "${OM_SG:-}" ] || check_tag sg "$OM_SG"
  [ -z "${OM_ROLE:-}" ] || { check_tag role "$OM_ROLE"; check_tag profile "$OM_ROLE"; }

  # the Spot request is persistent: cancel it FIRST or it would start a new instance
  if [ -n "${OM_SPOT_REQUEST:-}" ] && [ "$OM_SPOT_REQUEST" != None ]; then
    aws_ ec2 cancel-spot-instance-requests --spot-instance-request-ids "$OM_SPOT_REQUEST" >/dev/null
  fi
  if [ -n "${OM_INSTANCE:-}" ]; then
    echo "terminating $OM_INSTANCE"
    aws_ ec2 terminate-instances --instance-ids "$OM_INSTANCE" --query 'TerminatingInstances[0].CurrentState.Name' --output text
    aws_ ec2 wait instance-terminated --instance-ids "$OM_INSTANCE"
  fi
  if [ -n "${OM_SG:-}" ]; then
    echo "deleting security group $OM_SG"
    local try
    for try in 1 2 3 4 5 6; do aws_ ec2 delete-security-group --group-id "$OM_SG" >/dev/null 2>&1 && break; sleep 10; done
    aws_ ec2 describe-security-groups --group-ids "$OM_SG" >/dev/null 2>&1 && die "security group $OM_SG is still there"
  fi
  if [ -n "${OM_ROLE:-}" ]; then
    echo "deleting role $OM_ROLE"
    aws_ iam remove-role-from-instance-profile --instance-profile-name "$OM_ROLE" --role-name "$OM_ROLE"
    aws_ iam delete-instance-profile --instance-profile-name "$OM_ROLE"
    aws_ iam detach-role-policy --role-name "$OM_ROLE" --policy-arn "$SSM_POLICY"
    aws_ iam delete-role --role-name "$OM_ROLE"
  fi
  rm -f "$STATE"
  echo "cleaned. Anything still tagged $TAG_KEY=$TAG_VAL and alive:"
  aws_ ec2 describe-instances --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text
  echo "volumes left:"
  aws_ ec2 describe-volumes --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" --query 'Volumes[].VolumeId' --output text
}

cmd_status() {
  if [ -f "$STATE" ]; then
    echo "state: $STATE"; cat "$STATE"
    load_state
    echo "instance: $(aws_ ec2 describe-instances --instance-ids "$OM_INSTANCE" --query 'Reservations[0].Instances[0].[State.Name,InstanceType]' --output text)"
    echo "ssm: $(aws_ ssm describe-instance-information --filters "Key=InstanceIds,Values=$OM_INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)"
    [ "$(date +%F)" \< "$OM_REVIEW_BY" ] || echo "REVIEW DATE PASSED: decide whether to keep or destroy this box"
  else
    echo "no state file"
  fi
  echo "alive and tagged:"
  aws_ ec2 describe-instances --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType]' --output text
}

case "${1:-}" in
  up) cmd_up ;;
  ready) cmd_ready ;;
  run) shift; cmd_run "$@" ;;
  stop) cmd_stop ;;
  start) cmd_start ;;
  down) cmd_down ;;
  status) cmd_status ;;
  userdata) user_data ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
