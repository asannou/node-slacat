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
    if (name.startsWith("@")) {
      name = name.substr(1);
      const user = this.team.users.find(user => user.name == name);
      if (user) {
        return user;
      } else {
        console.error(`@${name} not found`);
        return;
      }
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
      const reUser = /(^|\s)@([-_.a-z0-9]+)/ig;
      obj.text = obj.text.replace(reUser, (match, s, name) => {
        const user = this.findUser(`@${name}`);
        return user ? `${s}<@${user.id}>` : match;
      });
      const reChannel = /(^|\s)#([-_.a-z0-9]+)/ig;
      obj.text = obj.text.replace(reChannel, (match, s, name) => {
        const channel = this.findChannel(`#${name}`);
        return channel ? `${s}<#${channel.id}>` : match;
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
    } else {
      delete obj.reply_to;
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
          this.push(self.transformChunk(chunk) + "\n");
        } catch (e) {
          console.error(e);
        }
        callback();
      }
    });
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
          self.unresolveName(obj);
          self.saveSend(obj);
          const setChannel = id => {
            if (id) {
              obj.channel = id;
            }
            this.push(JSON.stringify(obj));
            callback();
          };
          if (typeof obj.channel == "object") {
            const name = obj.channel.name;
            if (obj.type == "message") {
              self.openChannel(name, setChannel);
            } else {
              if (name.startsWith("@")) {
                const user = self.findUser(name);
                const im = user && self.findIm(user) || {};
                setChannel(im.id);
              } else {
                const channel = self.findChannel(name) || {};
                setChannel(channel.id);
              }
            }
          } else {
            setChannel();
          }
        } else {
          console.error("invalid object");
          callback();
        }
      }
    });
  };

  createRequestStream(transform) {
    const self = this;
    const request = new require("stream").Transform();
    request._transform = function(chunk, encoding, callback) {
      const obj = JSON.parse(chunk.toString());
      const channel = obj.channel;
      const create = () => {
        if (typeof channel == "object") {
          if (channel.name.startsWith("#")) {
            self.createChannels(channel.name, () => self.getTeamData());
          } else {
            self.createGroups(channel.name, () => self.getTeamData());
          }
        }
      };
      const func = {
        "channels_create": create,
        "groups_create": create,
        "channels_history": () => {
          if (typeof channel == "string") {
            self.getChannelsHistory(channel, transform);
          }
        },
        "activity_mentions": () => self.getActivityMentions(transform),
        "thread_getview": () => self.getThreadView(transform)
      };
      if (func[obj.type]) {
        func[obj.type]();
      } else {
        this.push(chunk);
      }
      callback();
    };
    return request;
  }

  createWebSocket(stream) {
    const ws = new (require("ws"))(this.url);
    const prepare = this.createPrepareStream();
    const transform = this.createTransformStream();
    const request = this.createRequestStream(transform);
    stream._write = (chunk, encoding, callback) => {
      prepare.write(chunk);
      callback();
    };
    stream.once("finish", () => ws.close());
    prepare.pipe(request);
    request.on("data", chunk => {
      const obj = JSON.parse(chunk.toString());
      if (obj.type == "rtm_start") {
        ws.close();
        this.getTeamData(() => {
          this.dumpTeamData();
          this.createWebSocket(stream);
        });
      } else {
        ws.send(chunk.toString());
      }
    });
    ws.on("message", data => transform.write(data + "\n"));
    ws.on("close", code => {
      console.error(`connection closed with code ${code}`);
      transform.end();
    });
    transform.on("data", chunk => stream.push(chunk));
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

