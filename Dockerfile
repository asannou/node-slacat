FROM node:alpine
WORKDIR /usr/src/app
COPY package.json .
RUN apk --no-cache add jq
RUN npm install
COPY index.js input.sh format.sh format.jq highlight.js rwlap.js client.sh ./
ENTRYPOINT ["./rwlap.js", "./client.sh"]
