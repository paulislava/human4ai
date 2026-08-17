#!/usr/bin/env python3
"""Самоподписанный сертификат для lan-proxy, когда на Windows нет openssl.

    python gencert.py <каталог> <lan-ip>

Пишет cert.pem/key.pem в каталог. Требует `cryptography` (есть в venv assistant
как зависимость requests[security]/websocket-client; если нет — поставится
командой из install-windows.ps1).
"""

import datetime
import ipaddress
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def main(out_dir, lan_ip):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "lan-proxy")])
    alt = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    try:
        alt.append(x509.IPAddress(ipaddress.ip_address(lan_ip)))
    except ValueError:
        pass
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .sign(key, hashes.SHA256()))
    with open(f"{out_dir}\\key.pem", "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM,
                                  serialization.PrivateFormat.TraditionalOpenSSL,
                                  serialization.NoEncryption()))
    with open(f"{out_dir}\\cert.pem", "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    print(f"сертификат записан в {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1")
