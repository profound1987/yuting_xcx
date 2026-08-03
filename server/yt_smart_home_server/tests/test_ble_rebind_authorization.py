import base64
import hashlib
import hmac
import os
from pathlib import Path
import sys
import tempfile
import unittest


SERVER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_ROOT))
_TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["YT_DATABASE_PATH"] = str(Path(_TEMP_DIR.name) / "ble-rebind-test.db")

from app.database import db, init_db  # noqa: E402
from app.services import (  # noqa: E402
    BLE_REBIND_AUTH_CONTEXT,
    device_finish_ble_bind,
    device_prepare_ble_bind,
    device_unbind,
    device_verify_ble_proof,
    ensure_seed_data,
    create_session,
    ensure_user,
    smart_led_capabilities,
)
from app.test_device_catalog import smart_led_test_device_key_hex  # noqa: E402


DEVICE_NO = "YT-SL-10000-74A7"
USER_ONE_PHONE = "13800001001"
USER_TWO_PHONE = "13800001002"


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def device_proof(bind_session_id: str, challenge: str) -> str:
    material = f"{DEVICE_NO}|{bind_session_id}|{challenge}".encode("utf-8")
    return b64url(hmac.new(bytes.fromhex(smart_led_test_device_key_hex(DEVICE_NO)), material, hashlib.sha256).digest())


class BleRebindAuthorizationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()
        ensure_seed_data()
        with db() as connection:
            user_one = ensure_user(connection, USER_ONE_PHONE)
            user_two = ensure_user(connection, USER_TWO_PHONE)
            cls.user_one_token = create_session(connection, user_one["id"])["sessionToken"]
            cls.user_two_token = create_session(connection, user_two["id"])["sessionToken"]

    def assert_authorization(self, prepared: dict, nonce: str, mode: str) -> None:
        authorization = prepared["rebindAuthorization"]
        self.assertEqual(authorization["version"], 1)
        self.assertEqual(authorization["mode"], mode)
        self.assertEqual(authorization["deviceNonce"], nonce)
        fields = (
            BLE_REBIND_AUTH_CONTEXT,
            authorization["deviceNo"],
            authorization["deviceNonce"],
            authorization["bindSessionId"],
            authorization["challenge"],
            authorization["userId"],
            authorization["mode"],
            str(authorization["expiresAt"]),
        )
        expected = b64url(
            hmac.new(
                bytes.fromhex(smart_led_test_device_key_hex(DEVICE_NO)),
                "|".join(fields).encode("utf-8"),
                hashlib.sha256,
            ).digest()
        )
        self.assertTrue(hmac.compare_digest(expected, authorization["signature"]))
        self.assertEqual(prepared["bindSessionId"], authorization["bindSessionId"])
        self.assertEqual(prepared["challenge"], authorization["challenge"])

    def verify_and_finish(self, session_token: str, prepared: dict) -> tuple[dict, dict]:
        verified_response = device_verify_ble_proof(
            {
                "sessionToken": session_token,
                "bindSessionId": prepared["bindSessionId"],
                "proof": device_proof(prepared["bindSessionId"], prepared["challenge"]),
                "capability": smart_led_capabilities("10000"),
            }
        )
        self.assertTrue(verified_response["success"], verified_response)
        finished_response = device_finish_ble_bind(
            {"sessionToken": session_token, "bindSessionId": prepared["bindSessionId"], "deviceName": "测试 Smart LED"}
        )
        self.assertTrue(finished_response["success"], finished_response)
        return verified_response["data"], finished_response["data"]

    def test_claim_recovery_and_other_user_protection(self) -> None:
        first_nonce = b64url(bytes(range(16)))
        unauthenticated = device_prepare_ble_bind(
            {"phone": USER_ONE_PHONE, "deviceNo": DEVICE_NO, "deviceNonce": first_nonce}
        )
        self.assertFalse(unauthenticated["success"])
        self.assertEqual(unauthenticated["code"], "SESSION_MISSING")

        first_response = device_prepare_ble_bind(
            {"sessionToken": self.user_one_token, "deviceNo": DEVICE_NO, "deviceNonce": first_nonce}
        )
        self.assertTrue(first_response["success"], first_response)
        first = first_response["data"]
        self.assertEqual(first["bindMode"], "claim")
        self.assert_authorization(first, first_nonce, "claim")
        first_owner, first_finished = self.verify_and_finish(self.user_one_token, first)
        self.assertEqual(first_finished["bindMode"], "claim")

        blocked = device_prepare_ble_bind(
            {"sessionToken": self.user_two_token, "deviceNo": DEVICE_NO, "deviceNonce": b64url(bytes(range(1, 17)))}
        )
        self.assertFalse(blocked["success"])
        self.assertEqual(blocked["code"], "DEVICE_ALREADY_BOUND")

        recovery_nonce = b64url(bytes(range(16, 32)))
        recovery_response = device_prepare_ble_bind(
            {"sessionToken": self.user_one_token, "deviceNo": DEVICE_NO, "deviceNonce": recovery_nonce}
        )
        self.assertTrue(recovery_response["success"], recovery_response)
        recovery = recovery_response["data"]
        self.assertEqual(recovery["bindMode"], "recover")
        self.assert_authorization(recovery, recovery_nonce, "recover")
        recovered_owner, recovered_finished = self.verify_and_finish(self.user_one_token, recovery)
        self.assertNotEqual(first_owner["ownerKey"], recovered_owner["ownerKey"])
        self.assertEqual(recovered_finished["bindMode"], "recover")

        unbound = device_unbind({"sessionToken": self.user_one_token, "deviceNo": DEVICE_NO})
        self.assertTrue(unbound["success"], unbound)

        replacement_nonce = b64url(bytes(range(32, 48)))
        replacement_response = device_prepare_ble_bind(
            {"sessionToken": self.user_two_token, "deviceNo": DEVICE_NO, "deviceNonce": replacement_nonce}
        )
        self.assertTrue(replacement_response["success"], replacement_response)
        replacement = replacement_response["data"]
        self.assertEqual(replacement["bindMode"], "claim")
        self.assert_authorization(replacement, replacement_nonce, "claim")

        with db() as connection:
            row = connection.execute(
                "SELECT bind_status, owner_user_id FROM device_registry WHERE device_no = ?",
                (DEVICE_NO,),
            ).fetchone()
            self.assertEqual(row["bind_status"], "unbound")
            self.assertIsNone(row["owner_user_id"])


if __name__ == "__main__":
    unittest.main()
