"""The real shape of `avatar_thumb`, which is not what the docs suggest.

The library's examples file describes the avatar as something you download with
`fetch_image_data(image=event.user.avatar_thumb)`, which reads like a URL. The
wire type is an ImageModel — a protobuf message with a `url_list: list[str]` on
it — so a helper that iterates `avatar_thumb` directly gets field names rather
than URLs and returns "" on every frame while reading as correct code. That is
not hypothetical: the first version of this helper did exactly that, produced an
empty avatar on every frame of a live room, and its test passed — because the
double it was written against had the wrong shape too.

So the first cases here build a real ImageModel from the installed library, and
the doubles after them copy that shape rather than inventing one.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sources.tiktok import avatar_url  # noqa: E402

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}   {detail}")


class FakeUser:
    """Whatever shape TikTokLive hands over, which is more than one."""

    def __init__(self, **attrs):
        for key, value in attrs.items():
            setattr(self, key, value)


def image(*urls):
    """A stand-in with the real thing's shape: a message holding url_list."""
    return FakeUser(url_list=list(urls))


def main_run():
    real = "https://p16-sign-va.tiktokcdn.com/abc~t0123.jpg"

    print("against the installed library's own type")
    try:
        from TikTokLiveProto.v3.webcast.model.base import ImageModel
    except ImportError as exc:
        check("TikTokLiveProto is importable", False, str(exc))
        print()
        print(f"{passed}/{passed + failed} assertions passed")
        raise SystemExit(1)

    check("a real ImageModel yields its url",
          avatar_url(FakeUser(nickname="kei", avatar_thumb=ImageModel(url_list=[real]))) == real)
    check("a real ImageModel with nothing in it is empty",
          avatar_url(FakeUser(avatar_thumb=ImageModel(url_list=[]))) == "")
    check("a real ImageModel with an unset field is empty",
          avatar_url(FakeUser(avatar_thumb=ImageModel())) == "")
    # The check that catches the original bug. An ImageModel is not a list of
    # URLs, so reading the attribute directly cannot work. Asserting url_list is
    # a list keeps this tied to the library's real field name rather than to a
    # shape this file made up.
    check("the field really is url_list on a message",
          isinstance(getattr(ImageModel(url_list=[real]), "url_list"), list))

    print("the shape the code reads, doubled from the real one")
    check("a comment's avatar comes back", avatar_url(FakeUser(avatar_thumb=image(real))) == real)
    check("the first usable entry wins",
          avatar_url(FakeUser(avatar_thumb=image(real, "https://other/second.jpg"))) == real)

    print("no user at all")
    check("None is empty", avatar_url(None) == "")

    print("a user with no avatar_thumb attribute")
    check("missing attribute is empty", avatar_url(FakeUser(nickname="kei")) == "")

    print("avatar_thumb that is None rather than an ImageModel")
    check("None is empty", avatar_url(FakeUser(avatar_thumb=None)) == "")

    print("an ImageModel holding nothing useful")
    check("empty url_list is empty", avatar_url(FakeUser(avatar_thumb=image())) == "")
    check("[None] is empty", avatar_url(FakeUser(avatar_thumb=image(None))) == "")
    check("[None, url] skips to the url",
          avatar_url(FakeUser(avatar_thumb=image(None, real))) == real)
    check('[""] is empty', avatar_url(FakeUser(avatar_thumb=image(""))) == "")
    check('["", "  "] is empty', avatar_url(FakeUser(avatar_thumb=image("", "  "))) == "")
    check("[None, '', '   ', url] walks to the url",
          avatar_url(FakeUser(avatar_thumb=image(None, "", "   ", real))) == real)

    print("a bare list where a message belongs")
    # Deliberately empty, and deliberately not supported. The installed library
    # types this as ImageModel and that is what the code reads. Accepting a bare
    # list as well would be a fallback for a shape nothing produces — the wrong
    # kind of generosity, because it would keep a future library change from
    # showing up as an empty avatar. Empty avatars are the ordinary case here
    # anyway, so a silent one costs nothing to spot and a swallowed change costs
    # a bug report.
    check("a bare list is not accepted as an avatar",
          avatar_url(FakeUser(avatar_thumb=[real])) == "")

    print("the wrong type entirely")
    # A string where a message belongs is the failure that would otherwise be
    # iterated character by character and hand back one letter as a URL.
    check("a bare string is not iterated into characters",
          avatar_url(FakeUser(avatar_thumb=real)) == "")
    check("a dict is empty", avatar_url(FakeUser(avatar_thumb={"url": real})) == "")
    check("an int is empty", avatar_url(FakeUser(avatar_thumb=7)) == "")

    print("whitespace is trimmed off a real URL")
    check("padded url comes back clean",
          avatar_url(FakeUser(avatar_thumb=image(f"  {real}  "))) == real)

    print("what it deliberately does not guard")
    # No try/except here. A `user` whose attribute access raises is not a shape
    # TikTokLive produces, and swallowing it would hide a library bug instead of
    # reporting it. Asserted so the choice stays a decision: if this ever starts
    # passing, someone added a blanket except and the reasoning above is now
    # wrong.
    class Hostile:
        @property
        def avatar_thumb(self):
            raise RuntimeError("no")

    try:
        avatar_url(Hostile())
        check("a raising attribute is not swallowed", False, "returned instead of raising")
    except RuntimeError:
        check("a raising attribute is not swallowed", True)


if __name__ == "__main__":
    main_run()
    print()
    print(f"{passed}/{passed + failed} assertions passed")
    if failed:
        print(f"{failed} FAILED")
        sys.exit(1)
    print("all passed")