"""Reserved Smart LED test devices for server and firmware integration.

These credentials are intentionally test-only. Production device keys must be
random per device and imported from the manufacturing system.
"""

import hashlib


SMART_LED_SPECS = {
    "0": {"code": "0", "width": 16, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
    "1": {"code": "1", "width": 32, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
    "2": {"code": "2", "width": 48, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
    "3": {"code": "3", "width": 64, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
    "4": {"code": "4", "width": 80, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
    "5": {"code": "5", "width": 96, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
    "6": {"code": "6", "width": 112, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
    "7": {"code": "7", "width": 128, "height": 16, "colorMode": "RGB", "pixelFormat": "RGB565"},
}

SMART_LED_TEST_DEVICES = [
    {"deviceNo": "YT-SL-00000-636F", "pin": "27559618"},
    {"deviceNo": "YT-SL-00001-8BBE", "pin": "63422909"},
    {"deviceNo": "YT-SL-00002-B2CD", "pin": "41201887"},
    {"deviceNo": "YT-SL-00003-5A1C", "pin": "61380908"},
    {"deviceNo": "YT-SL-00004-C02B", "pin": "29647382"},
    {"deviceNo": "YT-SL-10000-74A7", "pin": "83749261"},
    {"deviceNo": "YT-SL-10001-9C76", "pin": "26125290"},
    {"deviceNo": "YT-SL-10002-A505", "pin": "27831596"},
    {"deviceNo": "YT-SL-10003-4DD4", "pin": "98092861"},
    {"deviceNo": "YT-SL-10004-D7E3", "pin": "56864285"},
    {"deviceNo": "YT-SL-20000-4ABE", "pin": "60936153"},
    {"deviceNo": "YT-SL-20001-A26F", "pin": "55698295"},
    {"deviceNo": "YT-SL-20002-9B1C", "pin": "71073527"},
    {"deviceNo": "YT-SL-20003-73CD", "pin": "54664011"},
    {"deviceNo": "YT-SL-20004-E9FA", "pin": "77551456"},
    {"deviceNo": "YT-SL-30000-5D76", "pin": "52742481"},
    {"deviceNo": "YT-SL-30001-B5A7", "pin": "93644034"},
    {"deviceNo": "YT-SL-30002-8CD4", "pin": "95101055"},
    {"deviceNo": "YT-SL-30003-6405", "pin": "41180060"},
    {"deviceNo": "YT-SL-30004-FE32", "pin": "79076501"},
    {"deviceNo": "YT-SL-40000-30CD", "pin": "20069468"},
    {"deviceNo": "YT-SL-40001-D81C", "pin": "51617908"},
    {"deviceNo": "YT-SL-40002-E16F", "pin": "63511391"},
    {"deviceNo": "YT-SL-40003-09BE", "pin": "23242177"},
    {"deviceNo": "YT-SL-40004-9389", "pin": "36563171"},
    {"deviceNo": "YT-SL-50000-2705", "pin": "29087149"},
    {"deviceNo": "YT-SL-50001-CFD4", "pin": "86131583"},
    {"deviceNo": "YT-SL-50002-F6A7", "pin": "56001555"},
    {"deviceNo": "YT-SL-50003-1E76", "pin": "46447614"},
    {"deviceNo": "YT-SL-50004-8441", "pin": "95816404"},
    {"deviceNo": "YT-SL-60000-191C", "pin": "17614820"},
    {"deviceNo": "YT-SL-60001-F1CD", "pin": "22549396"},
    {"deviceNo": "YT-SL-60002-C8BE", "pin": "85809799"},
    {"deviceNo": "YT-SL-60003-206F", "pin": "35092185"},
    {"deviceNo": "YT-SL-60004-BA58", "pin": "31347420"},
    {"deviceNo": "YT-SL-70000-0ED4", "pin": "27373870"},
    {"deviceNo": "YT-SL-70001-E605", "pin": "14727120"},
    {"deviceNo": "YT-SL-70002-DF76", "pin": "28198015"},
    {"deviceNo": "YT-SL-70003-37A7", "pin": "52670758"},
    {"deviceNo": "YT-SL-70004-AD90", "pin": "24759811"},
]


def smart_led_test_device_key_hex(device_no: str) -> str:
    material = f"YUNTING-ZHICHE-TEST-DEVICE-KEY-V1|{device_no}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32].upper()
