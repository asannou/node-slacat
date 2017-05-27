#!/usr/bin/env node
"use strict";

function slurpStream(stream, callback) {
  let buf = "";
  stream.on("data", chunk => buf += chunk);
  stream.on("end", () => callback(buf));
}

function httpsGet(url, callback) {
  return require("https").get(url, res => slurpStream(res, callback));
}

function walkObject(obj, callback) {
  if (obj instanceof Object) {
    callback(obj);
    Object.keys(obj).forEach(key => walkObject(obj[key], callback));
  } else if (obj instanceof Array) {
    obj.forEach(o => walkObject(o, callback));
  }
}

function unescapeText(text) {
  return text
    .replace(/\x08/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

class Slacat {

  constructor(token) {
    this.token = token;
    this.send = {};
    this.sendId = 1;
  }

  indexTeamData(data) {
    this.url = data.url;
    this.self = data.self;
    this.index = {};
    const keys = ["users", "channels", "groups", "ims", "bots"];
    keys.forEach(key => data[key].forEach(obj => this.index[obj.id] = obj));
    this.index[data.team.id] = data.team;
  }

  dumpTeamData() {
    const parenthesis = count => count ? `(${count})` : "";
    const ims = this.team.ims;
    const users = this.team.users
      .filter(obj => !obj.deleted)
      .map(user => {
        const im = ims.find(im => im.user == user.id) || {};
        return "@" + user.name + parenthesis(im.unread_count_display);
      });
    const channels = this.team.channels
      .filter(obj => obj.is_member && !obj.is_archived)
      .map(channel => "#" + channel.name + parenthesis(channel.unread_count_display));
    const groups = this.team.groups
      .filter(obj => obj.is_open && !obj.is_archived)
      .map(group => group.name + parenthesis(group.unread_count_display));
    [users, channels, groups].forEach(obj => console.error(obj.join(" ")));
  }

  resolveName(obj) {
    const keys = ["user", "user_id", "channel", "bot_id", "team"];
    keys.forEach(key => {
      if (typeof obj[key] == "string") {
        const val = this.index[obj[key]] || {};
        let name = val.name;
        if (val.is_channel) {
          name = "#" + name;
        } else if (val.is_im) {
          name = "@" + this.index[val.user].name;
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
        const name = this.index[id].name;
        return prefix + name;
      });
    }
  }

  findChannelId(name) {
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
      const user = this.team.users.find(user => user.name == name);
      if (user) {
        func = im => im.user == user.id;
      } else {
        console.error(`user "${name}" not found`);
        return;
      }
    }
    const channel = this.team[key].find(func);
    if (channel) {
      return channel.id;
    } else {
      console.error(`channel "${name}" not found`);
      if (key == "ims") {
      }
      return;
    }
  }

  unresolveName(obj) {
    if (typeof obj.channel == "object") {
      const name = obj.channel.name.replace(/^@/, "~");
      const id = this.findChannelId(name);
      obj.channel = id;
    }
    if (typeof obj.text == "string") {
      const re = /\b([@#])([-_\.a-z0-9]+)/ig;
      obj.text = obj.text.replace(re, (m, prefix, name) => {
        const id = this.findChannelId(prefix + name);
        if (id) {
          return `<${prefix}${id}>`;
        } else {
          return prefix + name;
        }
      });
    }
  }

  saveSend(obj) {
    const max = 100;
    obj.id = this.sendId;
    this.send[this.sendId] = obj;
    this.sendId = this.sendId % max + 1;
  }

  loadSend(obj) {
    const id = obj.reply_to;
    obj.reply_to = this.send[id] || {};
    delete this.send[id];
  }

  transformChunk(chunk) {
    const obj = JSON.parse(chunk);
    if (typeof obj.reply_to == "number") {
      this.loadSend(obj);
      obj.user = this.self.id;
    }
    walkObject(obj, o => {
      this.resolveName(o);
      Object.keys(o)
        .filter(key => typeof o[key] == "string")
        .forEach(key => o[key] = unescapeText(o[key]));
    });
    return JSON.stringify(obj);
  }

  transformStream() {
    const self = this;
    return new require("stream").Transform({
      transform: function(chunk, encoding, callback) {
        try {
          this.push(self.transformChunk(chunk) + "\n");
        } catch (e) {
          console.error(e);
        }
        callback();
      }
    });
  }

  markChannel(key, id) {
    const URL = require("url").URL;
    const url = new URL(`https://slack.com/api/${key}.mark`);
    const params = url.searchParams;
    params.set("token", this.token);
    params.set("channel", id);
    params.set("ts", (new Date()).getTime() / 1000);
    httpsGet(url, data => {
      const obj = JSON.parse(data);
      obj.ok && console.error("channel marked");
    });
  }

  getChannelsHistory(id, stream) {
    const keys = {
      "C": "channels",
      "G": "groups",
      "D": "im"
    };
    const key = keys[id.substr(0, 1)];
    if (key) {
      const URL = require("url").URL;
      const url = new URL(`https://slack.com/api/${key}.history`);
      const params = url.searchParams;
      params.set("token", this.token);
      params.set("channel", id);
      params.set("count", 30);
      httpsGet(url, data => {
        const obj = JSON.parse(data);
        if (obj.ok) {
          obj.messages.reverse().forEach(o => {
            o.channel = id;
            stream.write(JSON.stringify(o) + "\n");
          });
          this.markChannel(key, id);
        }
      });
    }
  }

  getActivityMentions(stream) {
    const URL = require("url").URL;
    const url = new URL("https://medpeer.slack.com/api/activity.mentions");
    const params = url.searchParams;
    params.set("token", this.token);
    params.set("count", 30);
    httpsGet(url, data => {
      const obj = JSON.parse(data);
      if (obj.ok) {
        obj.mentions.reverse().forEach(o => {
          o.message.channel = o.channel;
          stream.write(JSON.stringify(o.message) + "\n");
        });
      }
    });
  }

  getThreadView(stream) {
    const URL = require("url").URL;
    const url = new URL("https://medpeer.slack.com/api/subscriptions.thread.getView");
    const params = url.searchParams;
    params.set("token", this.token);
    params.set("current_ts", (new Date()).getTime() / 1000);
    httpsGet(url, data => {
      const obj = JSON.parse(data);
      if (obj.ok) {
        obj.threads.forEach(thread => {
          delete thread.root_msg.thread_ts;
          stream.write(JSON.stringify(thread.root_msg) + "\n");
          thread.latest_replies.forEach(reply => {
            reply.channel = thread.root_msg.channel;
            stream.write(JSON.stringify(reply) + "\n");
          });
        });
      }
    });
  }

  validateStream() {
    const self = this;
    return new require("stream").Transform({
      transform: function(chunk, encoding, callback) {
        try {
          const obj = JSON.parse(chunk.toString());
          if (typeof obj.type == "string") {
            self.unresolveName(obj);
            self.saveSend(obj);
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
  };

  createWebSocket(stream) {
    const ws = new (require("ws"))(this.url);
    const validate = this.validateStream();
    const tranform = this.transformStream();
    stream._write = (chunk, encoding, callback) => {
      validate.write(chunk);
      callback();
    };
    validate.on("data", chunk => {
      const obj = JSON.parse(chunk.toString());
      const id = obj.channel;
      const func = {
        channels_history: () => id && this.getChannelsHistory(id, tranform),
        activity_mentions: () => this.getActivityMentions(tranform),
        thread_getview: () => this.getThreadView(tranform),
        rtm_start: () => {
          this.getTeamData(() => {
            ws.close();
            this.dumpTeamData();
            this.createWebSocket(stream);
          });
        },
      };
      if (func[obj.type]) {
        func[obj.type]();
      } else {
        ws.send(chunk.toString());
      }
    });
    stream.once("finish", () => ws.close());
    ws.on("message", data => tranform.write(data + "\n"));
    ws.on("close", code => {
      console.error(`connection closed with code ${code}`);
      tranform.end();
    });
    tranform.on("data", chunk => stream.push(chunk));
  }

  createStream() {
    const stream = new require("stream").Duplex({
      read: () => {},
      write: (chunk, encoding, callback) => {
        console.error("not ready");
        callback();
      }
    });
    this.getTeamData(() => {
      this.dumpTeamData();
      this.createWebSocket(stream);
    });
    return stream;
  }

  getTeamData(callback) {
    const URL = require("url").URL;
    const url = new URL("https://slack.com/api/rtm.start");
    const params = url.searchParams;
    params.set("token", this.token);
    httpsGet(url, data => {
      data = JSON.parse(data);
      this.team = data;
      this.indexTeamData(data);
      callback();
    });
  }

}

if (require.main === module) {
  const stream = (new Slacat(process.env.SLACK_TOKEN)).createStream();
  stream.on("finish", () => process.stdin.end());
  process.stdin.pipe(stream).pipe(process.stdout);
}

module.exports = Slacat;

