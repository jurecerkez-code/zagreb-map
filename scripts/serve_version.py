"""Serve web/ like scripts/serve.py, but answer data/current.json with a chosen version, so a new build can be checked
without switching the version the live server (and every other visitor of web/) gets.
Usage: python scripts/serve_version.py <port> <version>      e.g. python scripts/serve_version.py 8643 v20261021-city"""
import functools
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import WEB, NoStore, Server  # noqa: E402


class Pinned(NoStore):
    version = ""

    def do_GET(self):
        if self.path.split("?")[0] == "/data/current.json":
            body = json.dumps({"version": self.version}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main():
    port, version = int(sys.argv[1]), sys.argv[2]
    if not (WEB / "data" / version).is_dir():
        raise SystemExit(f"no web/data/{version}")
    Pinned.version = version
    with Server(("127.0.0.1", port), functools.partial(Pinned, directory=str(WEB))) as httpd:
        print(f"serving {WEB} on http://127.0.0.1:{port}/ with current.json = {version}", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
