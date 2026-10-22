"""Verifica a assinatura de um webhook do SempreCRM. Sem dependências (stdlib).

    from verify_webhook import verify_sempre_crm_signature
    ok = verify_sempre_crm_signature(raw_body_bytes, request.headers["SempreCRM-Signature"], [WHSEC])

raw_body: bytes EXATOS recebidos (não o JSON reencodado).
secrets: o segredo atual (e o antigo, durante uma rotação).
"""
import hashlib
import hmac
import time


def verify_sempre_crm_signature(raw_body: bytes, header: str, secrets, tolerance_seconds=300, now=None) -> bool:
    now = time.time() if now is None else now
    t = None
    signatures = []
    for part in (header or "").split(","):
        key, _, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if key == "t":
            try:
                t = int(value)
            except ValueError:
                return False
        elif key == "v1":
            signatures.append(value)
    if t is None or not signatures:
        return False
    if abs(now - t) > tolerance_seconds:
        return False

    signed = str(t).encode() + b"." + raw_body
    for secret in secrets:
        expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
        if any(hmac.compare_digest(expected, sig) for sig in signatures):
            return True
    return False
