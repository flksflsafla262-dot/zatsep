FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=3000 ALLOW_ANY_HOST=1 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server/index.js"]
