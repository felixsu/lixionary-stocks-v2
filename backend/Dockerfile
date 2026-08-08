FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Jakarta

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

RUN pip install --no-cache-dir uv

# Copy the lockfile too, so image builds are reproducible.
# v1 copied only pyproject.toml, which made every rebuild resolve fresh versions.
COPY pyproject.toml uv.lock* ./
RUN uv pip install --system --no-cache .

COPY app ./app

EXPOSE 8850

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8850"]
