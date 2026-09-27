# Konkretna wersja, nie :latest — ten sam Dockerfile za rok zbuduje ten sam obraz.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# Najpierw same zależności: ta warstwa odbuduje się tylko, gdy zmieni się requirements.txt.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home aplikacja && mkdir /dane && chown aplikacja /dane
USER aplikacja

ENV KATALOG_DANYCH=/dane
EXPOSE 8000
CMD ["python", "app.py"]
