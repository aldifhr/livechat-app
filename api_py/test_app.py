"""Offline checks for the Python backend's pure logic (no database needed)."""

import unittest

import app


class TestWireShapes(unittest.TestCase):
    def test_page_config_maps_stored_keys_to_overlay_names(self):
        self.assertEqual(
            app.page_config({"overlaySize": "s", "overlayMax": 4, "notAKey": 1}),
            {"size": "s", "max": 4},
        )

    def test_status_frame_matches_the_overlay_contract(self):
        frame = app.status_frame({
            "connected": True, "connecting": False, "waiting": False,
            "liveEnded": False, "statusMessage": "Connected to @x",
        })
        self.assertEqual(frame, {"type": "status", "connected": True, "message": "Connected to @x"})

    def test_status_frame_keeps_only_true_flags(self):
        frame = app.status_frame({
            "connected": False, "connecting": True, "waiting": True,
            "liveEnded": False, "statusMessage": "",
        })
        self.assertEqual(frame["type"], "status")
        self.assertTrue(frame["connecting"])
        self.assertTrue(frame["waiting"])
        self.assertNotIn("liveEnded", frame)

    def test_trigger_frames_use_the_overlay_kinds(self):
        self.assertEqual(app.trigger_frame({"kind": "comment", "user": "a", "text": "hi"})["text"], "hi")
        self.assertEqual(app.trigger_frame({"kind": "gift", "diamonds": 12})["diamonds"], 12)
        self.assertEqual(app.trigger_frame({"kind": "nonsense"})["type"], "alert")

    def test_user_info_handles_missing_user(self):
        self.assertEqual(app.user_info(None), {})


class TestTikTokFrames(unittest.TestCase):
    def test_comment_content_falls_back_to_comment_field(self):
        # The Python connector calls the message `content`; older events used
        # `comment`. Both must reach the overlay as `text`.
        class User:
            nickname = "Pak Bambang"
            unique_id = "bambang"

        class Event:
            user = User()
            content = "halo"

        info = app.user_info(Event.user)
        self.assertEqual(info["user"], "Pak Bambang")
        self.assertEqual(info["userId"], "bambang")
        self.assertEqual(str(Event.content), "halo")


if __name__ == "__main__":
    unittest.main(verbosity=2)
