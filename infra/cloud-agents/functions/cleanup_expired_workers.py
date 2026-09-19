import os
import time

import boto3


ec2 = boto3.client("ec2")


def tag_integer(tags, key, fallback):
    try:
        return int(tags.get(key, fallback))
    except (TypeError, ValueError):
        return fallback


def handler(_event, _context):
    project = os.environ["CLOUD_AGENT_PROJECT"]
    default_ttl_minutes = int(os.environ["DEFAULT_TTL_MINUTES"])
    now = int(time.time())
    expired = []

    paginator = ec2.get_paginator("describe_instances")
    pages = paginator.paginate(
        Filters=[
            {"Name": "tag:CloudAgentProject", "Values": [project]},
            {"Name": "tag:CloudAgentRole", "Values": ["worker"]},
            {"Name": "tag:Ephemeral", "Values": ["true"]},
            {
                "Name": "instance-state-name",
                "Values": ["pending", "running", "stopping", "stopped"],
            },
        ]
    )

    for page in pages:
        for reservation in page["Reservations"]:
            for instance in reservation["Instances"]:
                tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
                if (
                    tags.get("CloudAgentProject") != project
                    or tags.get("CloudAgentRole") != "worker"
                    or tags.get("Ephemeral") != "true"
                ):
                    continue
                # A hibernated guest is stopped on purpose and its disk is the
                # agent's saved state. Its run deadline has usually passed, so
                # only the tag separates it from an abandoned stopped worker.
                if tags.get("CloudAgentHibernated") == "true":
                    continue
                ttl_minutes = tag_integer(
                    tags, "CloudAgentDefaultTtlMinutes", default_ttl_minutes
                )
                inferred_expiry = (
                    int(instance["LaunchTime"].timestamp()) + ttl_minutes * 60
                )
                expires_at = tag_integer(
                    tags, "CloudAgentExpiresAtEpoch", inferred_expiry
                )
                if expires_at <= now:
                    expired.append(instance["InstanceId"])

    if expired:
        ec2.terminate_instances(InstanceIds=expired)

    return {"terminatedInstanceIds": expired}
