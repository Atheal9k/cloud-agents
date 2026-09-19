import importlib
import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock


class FakePaginator:
    def __init__(self, pages):
        self.pages = pages
        self.filters = None

    def paginate(self, *, Filters):
        self.filters = Filters
        return self.pages


class FakeEc2:
    def __init__(self, pages):
        self.paginator = FakePaginator(pages)
        self.terminated = []

    def get_paginator(self, operation):
        if operation != "describe_instances":
            raise AssertionError(operation)
        return self.paginator

    def terminate_instances(self, *, InstanceIds):
        self.terminated.append(InstanceIds)


def instance(instance_id, launch_epoch, tags):
    return {
        "InstanceId": instance_id,
        "LaunchTime": datetime.fromtimestamp(launch_epoch, timezone.utc),
        "Tags": [{"Key": key, "Value": value} for key, value in tags.items()],
    }


class CleanupExpiredWorkersTest(unittest.TestCase):
    def test_terminates_only_owned_expired_ephemeral_workers(self):
        now = 2_000_000_000
        owned = {
            "CloudAgentProject": "test-project",
            "CloudAgentRole": "worker",
            "Ephemeral": "true",
        }
        pages = [
            {
                "Reservations": [
                    {
                        "Instances": [
                            instance(
                                "i-expired",
                                now - 120,
                                {**owned, "CloudAgentExpiresAtEpoch": str(now - 1)},
                            ),
                            instance(
                                "i-newer-attempt",
                                now - 120,
                                {**owned, "CloudAgentExpiresAtEpoch": str(now + 600)},
                            ),
                            instance(
                                "i-fallback-expired",
                                now - 3_601,
                                {
                                    **owned,
                                    "CloudAgentExpiresAtEpoch": "invalid",
                                    "CloudAgentDefaultTtlMinutes": "60",
                                },
                            ),
                            instance(
                                "i-hibernated",
                                now - 86_400,
                                {
                                    **owned,
                                    "CloudAgentExpiresAtEpoch": str(now - 3_600),
                                    "CloudAgentHibernated": "true",
                                },
                            ),
                            instance(
                                "i-mac-host",
                                now - 86_400,
                                {
                                    "CloudAgentProject": "test-project",
                                    "CloudAgentRole": "worker",
                                    "Ephemeral": "false",
                                    "CloudAgentLifecycle": "dedicated-host",
                                    "CloudAgentExpiresAtEpoch": str(now - 1),
                                },
                            ),
                            instance(
                                "i-controller",
                                now - 3_601,
                                {
                                    "CloudAgentProject": "test-project",
                                    "CloudAgentRole": "controller",
                                    "Retention": "permanent",
                                },
                            ),
                        ]
                    }
                ]
            }
        ]
        fake_ec2 = FakeEc2(pages)
        fake_boto3 = SimpleNamespace(client=lambda service: fake_ec2)

        with mock.patch.dict(
            os.environ,
            {"CLOUD_AGENT_PROJECT": "test-project", "DEFAULT_TTL_MINUTES": "120"},
            clear=False,
        ), mock.patch.dict(sys.modules, {"boto3": fake_boto3}):
            module = importlib.import_module("cleanup_expired_workers")
            module.ec2 = fake_ec2
            with mock.patch.object(module.time, "time", return_value=now):
                result = module.handler({}, None)

        self.assertEqual(
            result,
            {"terminatedInstanceIds": ["i-expired", "i-fallback-expired"]},
        )
        self.assertEqual(fake_ec2.terminated, [["i-expired", "i-fallback-expired"]])
        self.assertIn(
            {"Name": "tag:Ephemeral", "Values": ["true"]},
            fake_ec2.paginator.filters,
        )
        # A stopped snapshot holds an idle agent's disk. Its run deadline has
        # long passed, so the backstop must read the tag rather than the clock.
        self.assertNotIn("i-hibernated", fake_ec2.terminated[0])
        # Mac Dedicated Hosts are not Linux TTL workers. The backstop must not
        # terminate them even if they appear in the describe pages.
        self.assertNotIn("i-mac-host", fake_ec2.terminated[0])


if __name__ == "__main__":
    unittest.main()
