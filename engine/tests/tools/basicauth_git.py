"""Smart-HTTP git server behind HTTP Basic auth, for the credential prompt tests.

Usage: python3 basicauth_git.py PORT_FILE PROJECT_ROOT USER PASSWORD

Serves the repositories under PROJECT_ROOT through `git http-backend` on an
ephemeral 127.0.0.1 port, which it writes to PORT_FILE once listening. Every
request without the right credentials gets a 401 challenge, as a hosting
service answers a client that has none.
"""

import base64
import http.server
import os
import subprocess
import sys

PORT_FILE, ROOT, USER, PASSWORD = sys.argv[1:5]
EXPECTED = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle_any(self):
        if self.headers.get("Authorization", "") != EXPECTED:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="gitglasses-tests"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        path, _, query = self.path.partition("?")
        body = b""
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    break
                body += self.rfile.read(size)
                self.rfile.readline()
        elif self.headers.get("Content-Length"):
            body = self.rfile.read(int(self.headers["Content-Length"]))
        env = dict(os.environ)
        env.update(
            {
                "GIT_PROJECT_ROOT": ROOT,
                "GIT_HTTP_EXPORT_ALL": "1",
                "REMOTE_USER": USER,
                "REQUEST_METHOD": self.command,
                "PATH_INFO": path,
                "QUERY_STRING": query,
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": str(len(body)),
                "REMOTE_ADDR": "127.0.0.1",
                "HTTP_CONTENT_ENCODING": self.headers.get("Content-Encoding", ""),
                "GIT_PROTOCOL": self.headers.get("Git-Protocol", ""),
            }
        )
        out = subprocess.run(
            ["git", "http-backend"], input=body, env=env, capture_output=True
        ).stdout
        head, _, payload = out.partition(b"\r\n\r\n")
        status = 200
        headers = []
        for line in head.split(b"\r\n"):
            key, _, value = line.decode().partition(":")
            if key.lower() == "status":
                status = int(value.strip().split()[0])
            elif key:
                headers.append((key, value.strip()))
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = handle_any
    do_POST = handle_any

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE + ".tmp", "w") as out:
    out.write(str(server.server_address[1]))
os.replace(PORT_FILE + ".tmp", PORT_FILE)
server.serve_forever()
