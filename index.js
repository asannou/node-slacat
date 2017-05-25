#!/usr/bin/env node
"use strict";

const send = {};
let sendId = 1;

function slurpStream(stream, callback) {
    let buf = "";
    stream.on("data", chunk => buf += chunk);
    stream.on("end", () => callback(buf));
}

const httpsGet = (url, callback) => require("https").get(url, res => slurpStream(res, callback));

function indexTeamData(data) {
    const index = { self: data.self };
    const keys = ["users", "channels", "groups", "ims", "bots"];
    keys.forEach(key => data[key].forEach(obj => index[obj.id] = obj));
    index[data.team.id] = data.team;
    return index;
}

function dumpTeamData(data) {
    const users = data.users.filter(obj => !obj.deleted);
    const channels = data.channels.filter(obj => obj.is_member && !obj.is_archived);
    const groups = data.groups.filter(obj => obj.is_open && !obj.is_archived);
    return [
        users.map(obj => "@" + obj.name),
        channels.map(obj => "#" + obj.name),
        groups.map(obj => obj.name)
    ];
}

function walkObject(obj, callback) {
    if (obj instanceof Object) {
        callback(obj);
        Object.keys(obj).forEach(key => walkObject(obj[key], callback));
    } else if (obj instanceof Array) {
        obj.forEach(o => walkObject(o, callback));
    }
}

function resolveName(obj, index) {
    const keys = ["user", "user_id", "channel", "bot_id", "team"];
    keys.forEach(key => {
        if (typeof obj[key] == "string") {
            const val = index[obj[key]] || {};
            let name = val.name;
            if (val.is_channel) {
                name = "#" + name;
            } else if (val.is_im) {
                name = "@" + index[val.user].name;
            } else if (typeof val.is_bot == "boolean") {
                name = "@" + name;
            }
            obj[key] = {
                id: obj[key],
                name: name
            };
        }
    });
    if (typeof obj.text == "string") {
        const re = /<([@#])([A-Z0-9]+)(\|[^>]+)?>/g;
        obj.text = obj.text.replace(re, (m, prefix, id) => {
            const name = index[id].name;
            return prefix + name;
        });
    }
}

function findChannelId(name, data) {
    const keys = {
        "@": "users",
        "#": "channels",
        "~": "ims"
    };
    let key = keys[name.substr(0, 1)];
    if (key) {
        name = name.substr(1);
    } else {
        key = "groups";
    }
    let func = channel => channel.name == name;
    if (key == "ims") {
        const user = data.users.find(user => user.name == name);
        func = im => im.user == user.id;
    }
    const channel = data[key].find(func);
    if (channel) {
        return channel.id;
    } else {
        console.error(`channel "${name}" not found`);
        return;
    }
}

function unresolveName(obj, data) {
    if (typeof obj.channel == "object") {
        const name = obj.channel.name.replace(/^@/, "~");
        const id = findChannelId(name, data);
        obj.channel = id;
    }
    if (typeof obj.text == "string") {
        const re = /\b([@#])([-_\.a-z0-9]+)/ig;
        obj.text = obj.text.replace(re, (m, prefix, name) => {
            const id = findChannelId(prefix + name, data);
            if (id) {
                return "<" + prefix + id + ">";
            } else {
                return prefix + name;
            }
        });
    }
}

function saveSend(obj) {
    const max = 100;
    obj.id = sendId;
    send[sendId] = obj;
    sendId = sendId % max + 1;
}

function loadSend(obj) {
    const id = obj.reply_to;
    obj.reply_to = send[id] || {};
    delete send[id];
}

function unescapeText(text) {
    return text
        .replace(/\x08/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function transformChunk(chunk, index) {
    const obj = JSON.parse(chunk);
    if (typeof obj.reply_to == "number") {
        loadSend(obj);
        obj.user = index.self.id;
    }
    walkObject(obj, o => {
        resolveName(o, index);
        Object.keys(o)
            .filter(key => typeof o[key] == "string")
            .forEach(key => o[key] = unescapeText(o[key]));
    });
    return JSON.stringify(obj);
}

const transformStream = index => new require("stream").Transform({
    transform: function(chunk, encoding, callback) {
        try {
            this.push(transformChunk(chunk, index) + "\n");
        } catch (e) {
            console.error(e);
        }
        callback();
    }
});

function getChannelsHistory(id, stream) {
    const keys = {
        "C": "channels",
        "G": "groups",
        "D": "im"
    };
    const key = keys[id.substr(0, 1)];
    if (key) {
        const URL = require("url").URL;
        const url = new URL("https://slack.com/api/" + key + ".history");
        const params = url.searchParams;
        params.set("token", process.env.SLACK_TOKEN);
        params.set("channel", id);
        params.set("count", 30);
        httpsGet(url, data => {
            const obj = JSON.parse(data);
            if (obj.ok) {
                obj.messages.reverse().forEach(o => {
                    o.channel = id;
                    stream.write(JSON.stringify(o) + "\n");
                });
            }
        });
    }
}

const validateStream = data => new require("stream").Transform({
    transform: function(chunk, encoding, callback) {
        try {
            const obj = JSON.parse(chunk.toString());
            if (typeof obj.type == "string") {
                unresolveName(obj, data);
                saveSend(obj);
                this.push(JSON.stringify(obj));
            } else {
                console.error("invalid object");
            }
        } catch (e) {
            console.error(e);
        }
        callback();
    }
});

function createWebSocket(data, stream) {
    const ws = new (require("ws"))(data.url);
    const validate = validateStream(data);
    const index = indexTeamData(data);
    const tranform = transformStream(index);
    stream._write = (chunk, encoding, callback) => {
        validate.write(chunk);
        callback();
    };
    validate.on("data", chunk => {
        const obj = JSON.parse(chunk.toString());
        if (obj.type == "channels_history") {
            getChannelsHistory(obj.channel || "", tranform);
        } else {
            ws.send(chunk.toString());
        }
    });
    stream.on("finish", () => ws.close());
    ws.on("message", data => tranform.write(data + "\n"));
    ws.on("close", code => {
        console.error(code);
        tranform.end();
        stream.end();
    });
    tranform.on("data", chunk => stream.push(chunk));
}

function createStream() {
    const stream = new require("stream").Duplex({
        read: () => {},
        write: (chunk, encoding, callback) => {
            console.error("not ready");
            callback();
        }
    });
    const URL = require("url").URL;
    const url = new URL("https://slack.com/api/rtm.start");
    const params = url.searchParams;
    params.set("token", process.env.SLACK_TOKEN);
    httpsGet(url, data => {
        data = JSON.parse(data);
        dumpTeamData(data).forEach(obj => console.error(obj.join(" ")));
        createWebSocket(data, stream)
    });
    return stream;
}

if (require.main === module) {
    process.stdin
        .pipe(createStream().on("finish", () => process.stdin.end()))
        .pipe(process.stdout);
}

module.exports.createStream = createStream;
