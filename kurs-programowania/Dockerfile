# Cały kurs w kontenerze — bez instalowania Pythona na komputerze.
#   docker build -t kurs-programowania .
#   docker run -it --rm -v "${PWD}:/kurs" kurs-programowania            (PowerShell)
#   docker run -it --rm -v "$(pwd):/kurs" kurs-programowania            (bash)
FROM python:3.12-slim

# git — do lekcji 04 (jeden z jej testów tworzy prawdziwe repozytorium).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /kurs
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home kursant && chown -R kursant /kurs
USER kursant

ENTRYPOINT ["python", "kurs.py"]
