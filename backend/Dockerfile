FROM python:3.12-slim

WORKDIR /app

# Optional: drop extra-ca.crt next to this Dockerfile to trust a corporate/
# TLS-intercepting proxy during the build. No-op when the file is absent.
COPY requirements.txt extra-ca*.crt ./
RUN if [ -f extra-ca.crt ]; then \
      cp extra-ca.crt /usr/local/share/ca-certificates/extra-ca.crt && \
      update-ca-certificates && \
      pip config set global.cert /etc/ssl/certs/ca-certificates.crt; \
    fi
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

# --workers 1 is load-bearing: the feature graph lives in process memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
