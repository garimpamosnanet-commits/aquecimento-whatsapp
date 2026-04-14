FROM node:20-alpine

# Set timezone to Brazil (BRT = UTC-3)
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime && \
    echo "America/Sao_Paulo" > /etc/timezone && \
    apk del tzdata

ENV TZ=America/Sao_Paulo

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY BUILD_VERSION /tmp/build_version
COPY . .

RUN mkdir -p sessions data media/audios media/images media/stickers

EXPOSE 3001

CMD ["node", "server.js"]
