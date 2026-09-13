"""Parse bounded multipart uploads without the removed stdlib cgi module."""

from email import policy
from email.parser import BytesParser


def parse_upload(content_type: str, body: bytes):
    # The HTTP handler enforces the total body limit before calling this parser.
    header = content_type.encode("ascii", errors="strict")
    if b"\r" in header or b"\n" in header:
        raise ValueError("Invalid multipart content type")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + header + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    if not message.is_multipart() or any(part.defects for part in message.walk()):
        raise ValueError("Malformed multipart/form-data upload")
    fields = {}
    upload = None
    for part in message.iter_parts():
        if part.is_multipart() or part.get_content_disposition() != "form-data":
            raise ValueError("Expected flat multipart/form-data fields")
        name = part.get_param("name", header="content-disposition")
        if not name:
            raise ValueError("Multipart field is missing its name")
        data = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        if name == "file":
            if upload is not None:
                raise ValueError("Upload exactly one file per request")
            upload = (filename or "document", data, part.get_content_type())
        elif filename is None:
            try:
                fields.setdefault(name, data.decode(part.get_content_charset() or "utf-8"))
            except (UnicodeError, LookupError) as error:
                raise ValueError("Multipart text field has invalid encoding") from error
    return fields, upload
