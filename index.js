#!/usr/bin/env node
"use strict";

function slurpStream(stream, callback) {
  let buf = "";
  stream.on("data", chunk => buf += chunk);
  stream.on("end", () => callback(buf));
}

function httpsGet(url, callback) {
  require("https").get(url, res => slurpStream(res, callback));
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
  }

  indexTeamData(data) {
    this.url = data.url;
    this.self = data.self;
    this.index = {};
    const keys = ["users", "channels", "groups", "ims", "bots"];
    keys.forEach(key => data[key].forEach(obj => this.index[obj.id] = obj));
    this.index[data.team.id] = data.team;
  }

  dumpCommands() {
    const commands = [
      "/archive", "/away", "/dnd", "/leave", "/me",
      "/mute", "/remind", "/shrug", "/status", "/who"
    ];
    console.error(commands.join(" "));
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

  openChannel(name, callback) {
    const getTeamData = id => this.getTeamData(() => callback(id));
    if (name.startsWith("@")) {
      const user = this.findUser(name);
      if (user) {
        const im = this.findIm(user);
        if (im) {
          callback(im.id);
        } else {
          this.openIm(user.id, getTeamData);
        }
      } else {
        console.error(`@${name} not found`);
        callback();
      }
    } else {
      const channel = this.findChannel(name);
      if (channel) {
        if (channel.is_member || channel.is_group) {
          callback(channel.id);
        } else {
          this.joinChannels(name, getTeamData);
        }
      } else {
        callback();
      }
    }
  }

  findUser(name) {
    name = name.substr(1);
    const user = this.team.users.find(user => user.name == name);
    if (user) {
      return user;
    } else {
      console.error(`@${name} not found`);
      return;
    }
  }

  findIm(user) {
    const im = this.team.ims.find(im => im.user == user.id);
    if (im) {
      return im
    } else {
      console.error(`im @${user.name} not found`);
      return;
    }
  }

  findChannel(name) {
    let prefix = name.substr(0, 1);
    let key;
    if (prefix == "#") {
      name = name.substr(1);
      key = "channels";
    } else {
      prefix = "";
      key = "groups";
    }
    const channel = this.team[key].find(channel => channel.name == name);
    if (channel) {
      return channel;
    } else {
      console.error(`${prefix}${name} not found`);
      return;
    }
  }

  unresolveName(obj) {
    if (typeof obj.text == "string") {
      const find = (name, func) => {
        const found = name.startsWith("@") ?
          func(name) :
          this.findChannel(name);
        return found && found.id;
      }
      const re = /(^|\s)([@#][-_.a-z0-9]+)/ig;
      obj.text = obj.text.replace(re, (match, s, name) => {
        const prefix = name.substr(0, 1);
        const id = find(name, name => this.findUser(name));
        return s + (id ? `<${prefix}${id}>` : name);
      });
      const reUrl = new RegExp("(\.slack\.com/archives/)([@#]?[-_.a-z0-9]+)", "g");
      obj.text = obj.text.replace(reUrl, (match, url, name) => {
        const id = find(name, name => {
          const user = this.findUser(name);
          return user && this.findIm(user);
        });
        return url + (id || name);
      });
    }
  }

  initSend() {
    this.send = {};
    this.sendId = 1;
  }

  saveSend(obj) {
    const max = 100;
    obj.id = this.sendId;
    this.send[this.sendId] = obj;
    this.sendId = this.sendId % max + 1;
  }

  loadSend(obj) {
    const id = obj.reply_to;
    if (typeof id == "number") {
      obj.reply_to = this.send[id];
      delete this.send[id];
      obj.user = this.self.id;
    } else {
      delete obj.reply_to;
    }
    return obj.reply_to;
  }

  transformChunk(chunk) {
    const obj = JSON.parse(chunk);
    if (obj.reply_to && !this.loadSend(obj)) {
      return;
    }
    if (obj.type == "pong") {
      clearTimeout(obj.reply_to.timeout);
      delete obj.reply_to.timeout;
      return;
    }
    walkObject(obj, o => {
      this.resolveName(o);
      Object.keys(o)
        .filter(key => typeof o[key] == "string")
        .forEach(key => o[key] = unescapeText(o[key]));
    });
    return JSON.stringify(obj);
  }

  createTransformStream() {
    const self = this;
    return new require("stream").Transform({
      transform: function(chunk, encoding, callback) {
        try {
          const transformed = self.transformChunk(chunk);
          if (transformed) {
            this.push(transformed + "\n");
          }
        } catch (e) {
          console.error(e);
        }
        callback();
      }
    });
  }

  sendPing() {
    const obj = { type: "ping" };
    this.saveSend(obj);
    this.ws.send(JSON.stringify(obj));
    obj.timeout = setTimeout(() => this.startRtm(), 5000);
  }

  requestApi(path, param, success, error) {
    const URL = require("url").URL;
    const url = new URL(`https://slack.com/api/${path}`);
    const params = url.searchParams;
    params.set("token", this.token);
    Object.keys(param).forEach(key => params.set(key, param[key]));
    httpsGet(url, data => {
      const obj = JSON.parse(data);
      if (obj.ok) {
        success(obj);
      } else {
        error && error(obj)
      }
    });
  }

  markChannel(key, id) {
    this.requestApi(`${key}.mark`, {
      channel: id,
      ts: (new Date()).getTime() / 1000
    }, () => {
      console.error("channel marked");
    });
  }

  commandChat(channel, command, text) {
    this.requestApi(`chat.command`, {
      channel: channel,
      command: command,
      text: text
    }, obj => {
      console.error(obj.response || "commanded");
    }, obj => {
      console.error(obj.error);
    });
  }

  openIm(id, callback) {
    this.requestApi("im.open", {
      user: id
    }, obj => {
      console.error("im opened");
      callback(obj.channel.id);
    }, obj => {
      console.error(obj.error);
      callback();
    });
  }

  joinChannels(name, callback) {
    this.requestApi("channels.join", {
      name: name
    }, obj => {
      console.error(`${name} joined`);
      callback(obj.channel.id);
    }, obj => {
      console.error(obj.error);
      callback();
    });
  }

  createChannels(name, callback) {
    this.requestApi("channels.create", {
      name: name
    }, obj => {
      console.error(`${name} created`);
      callback(obj.channel.id);
    }, obj => {
      console.error(obj.error);
      callback();
    });
  }

  createGroups(name, callback) {
    this.requestApi("groups.create", {
      name: name
    }, obj => {
      console.error(`${name} created`);
      callback(obj.group.id);
    }, obj => {
      console.error(obj.error);
      callback();
    });
  }

  getChannelsHistory(id, stream) {
    const keys = {
      "C": "channels",
      "G": "groups",
      "D": "im"
    };
    const prefix = id.substr(0, 1);
    const key = keys[prefix];
    if (key) {
      this.requestApi(`${key}.history`, {
        channel: id,
        count: 30
      }, obj => {
        obj.messages.reverse().forEach(o => {
          o.channel = id;
          stream.write(JSON.stringify(o) + "\n");
        });
        this.markChannel(key, id);
      }, obj => {
        console.error(obj.error);
      });
    }
  }

  getActivityMentions(stream) {
    this.requestApi("activity.mentions", {
      count: 30
    }, obj => {
      obj.mentions.reverse().forEach(o => {
        o.message.channel = o.channel;
        stream.write(JSON.stringify(o.message) + "\n");
      });
    });
  }

  getThreadView(stream) {
    this.requestApi("subscriptions.thread.getView", {
      current_ts: (new Date()).getTime() / 1000
    }, obj => {
      obj.threads.forEach(thread => {
        delete thread.root_msg.thread_ts;
        stream.write(JSON.stringify(thread.root_msg) + "\n");
        thread.latest_replies.forEach(reply => {
          reply.channel = thread.root_msg.channel;
          stream.write(JSON.stringify(reply) + "\n");
        });
      });
    });
  }

  startRtm() {
    this.ws.close();
    this.getTeamData(() => {
      this.dumpTeamData();
      this.createWebSocket(this.stream);
    });
  }

  prepareChunk(chunk, callback) {
    this.unresolveName(chunk);
    this.saveSend(chunk);
    if (typeof chunk.channel == "object") {
      const name = chunk.channel.name;
      if (chunk.type == "message") {
        this.openChannel(name, callback);
      } else {
        if (name.startsWith("@")) {
          const user = this.findUser(name);
          const im = user && this.findIm(user) || {};
          callback(im.id);
        } else {
          const channel = this.findChannel(name) || {};
          callback(channel.id);
        }
      }
    } else {
      callback();
    }
  }

  createPrepareStream() {
    const self = this;
    return new require("stream").Transform({
      transform: function(chunk, encoding, callback) {
        let obj;
        try {
          obj = JSON.parse(chunk.toString());
        } catch (e) {
          console.error(e);
          return callback();
        }
        if (typeof obj.type == "string") {
          self.prepareChunk(obj, id => {
            if (id) {
              obj.channel = id;
            }
            this.push(JSON.stringify(obj));
            callback();
          });
        } else {
          console.error("invalid object");
          callback();
        }
      }
    });
  };

  requestChunk(chunk, stream) {
    const channel = chunk.channel;
    const create = () => {
      if (typeof channel == "object") {
        const key = channel.name.startsWith("#") ?
          "createChannels" :
          "createGroups";
        this[key](channel.name, () => this.getTeamData());
      }
    };
    const history = () => {
      if (typeof channel == "string") {
        this.getChannelsHistory(channel, stream);
      }
    };
    const func = {
      "channels_create": create,
      "groups_create": create,
      "channels_history": history,
      "activity_mentions": () => this.getActivityMentions(stream),
      "thread_getview": () => this.getThreadView(stream),
      "rtm_start": () => this.startRtm()
    };
    if (func[chunk.type]) {
      func[chunk.type]();
      return true;
    } else if (chunk.type == "message" && chunk.text.startsWith("/")) {
      const text = chunk.text.split(" ");
      this.commandChat(channel, text.shift(), text.join(" "));
      return true;
    } else {
      return false;
    }
  }

  createRequestStream(stream) {
    const self = this;
    return new require("stream").Transform({
      transform: function(chunk, encoding, callback) {
        const obj = JSON.parse(chunk.toString());
        if (!self.requestChunk(obj, stream)) {
          this.push(chunk);
        }
        callback();
      }
    });
  }

  createWebSocket() {
    this.ws = new (require("ws"))(this.url);
    this.initSend();
    const prepare = this.createPrepareStream();
    const transform = this.createTransformStream();
    const request = this.createRequestStream(transform);
    this.stream._write = (chunk, encoding, callback) => {
      prepare.write(chunk);
      callback();
    };
    const onFinish = () => this.ws.close();
    this.stream.once("finish", onFinish);
    prepare.pipe(request);
    request.on("data", chunk => this.ws.send(chunk.toString()));
    let ping;
    this.ws.on("open", code => {
      console.error("connection opened");
      ping = setInterval(() => this.sendPing(), 10000);
    });
    this.ws.on("message", data => transform.write(data + "\n"));
    this.ws.on("close", code => {
      console.error(`connection closed with code ${code}`);
      clearInterval(ping);
      this.stream.removeListener("finish", onFinish);
      prepare.end();
      transform.end();
    });
    transform.on("data", chunk => this.stream.push(chunk));
  }

  createStream() {
    this.stream = new require("stream").Duplex({
      read: () => {},
      write: (chunk, encoding, callback) => {
        console.error("not ready");
        callback();
      }
    });
    this.getTeamData(() => {
      this.dumpCommands();
      this.dumpTeamData();
      this.createWebSocket();
    });
    return this.stream;
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
      callback && callback();
    });
  }

}

if (require.main === module) {
  const stream = (new Slacat(process.env.SLACK_TOKEN)).createStream();
  stream.on("finish", () => process.stdin.end());
  process.stdin.pipe(stream).pipe(process.stdout);
}

module.exports = Slacat;

