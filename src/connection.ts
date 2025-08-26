import { endianness as getEndianness } from "node:os";
import type { Compositor } from "./compositor.js";
import { interfaces, WlArg, WlMessage } from "./wayland_interpreter.js";

import { USocket } from "@cathodique/usocket";

import FIFO from "fast-fifo";
import { snakePrepend, snakeToCamel } from "./utils.js";

import { console } from "./logger.js";
import { EventEmitter } from "node:stream";

export const endianness = getEndianness();
export const read = (b: Buffer, i: number, signed: boolean = false) => {
  const unsignedness = signed ? "" : "U";
  return b[`read${unsignedness}Int32${endianness}`](i);
};
const write = (v: number, b: Buffer, i: number, signed: boolean = false) => {
  const unsignedness = signed ? "" : "U";
  return b[`write${unsignedness}Int32${endianness}`](v, i);
};

export function parseOnReadable(
  sock: USocket,
  callback: ({ data, fds }: { data: Buffer; fds: number[] }) => void,
) {
  try {
    while (true) {
      const { data: headerStuff, fds: fds1 } = sock.read(8, null) || {
        data: null,
        fds: null,
      };
      if (!headerStuff) return;
      const metadataNumber = read(headerStuff, 4);
      const size = metadataNumber >> 16;

      const { data: payload, fds: fds2 } = sock.read(size - 8, null) || {
        data: null,
        fds: null,
      };

      const data = Buffer.concat([headerStuff, payload || Buffer.from([])]);

      const fds = [...(fds1 || []), ...(fds2 || [])];
      callback({ data, fds });
    }
  } catch (err) {
    console.error(err);
  }
}

interface ParsingContext<V> {
  buf: Buffer;
  idx: number;
  fdQ: FIFO<number>;
  callbacks: ((args: Record<string, any>) => void)[];
  parent: V;
}

export interface ConnectionParams<V extends ObjectReference, U extends Connection<V>> {
  createObjRef(this: U, args: Record<string, any>, ifaceName: string, newOid: number, parent?: V, version?: number): V;
  call?(this: U, object: V, fnName: string, args: Record<string, any>): void;
}

export class ObjectReference<T extends Record<string, any[]> | [never] = Record<string, any[]> | [never]> extends EventEmitter<T> {
  iface: string;
  _version: number | undefined;
  oid: number;
  parent: ObjectReference<any>;

  constructor(ifaceName: string, newOid: number, parent?: ObjectReference<any>, version?: number) {
    super();

    this.iface = ifaceName;
    this._version = version;
    this.oid = newOid;
    this.parent = parent ?? this;
  }

  get version(): number {
    return this._version ?? this.parent.version;
  }
}

// I hate TypeScript I hate TypeScript I hate TypeScript I hate TypeScript I hate TypeScript I hate TypeScript
export class Connection<V extends ObjectReference> extends EventEmitter {
  compositor: Compositor<V, Connection<V>>;
  socket: USocket;
  socket2?: USocket;
  connId: number;

  fdQ: FIFO<number>;

  params: ConnectionParams<V, Connection<V>>;

  constructor(
    connId: number,
    comp: Compositor<V, Connection<V>>,
    sock: USocket,
    params: ConnectionParams<V, Connection<V>>,
  ) {
    super();

    this.connId = connId;
    this.compositor = comp;
    this.socket = sock;
    this.params = params;

    this.fdQ = new FIFO();

    // Handle data from the client
    sock.on("readable", async function (this: Connection<V>) {
      parseOnReadable(sock, function (this: Connection<V>, { data, fds }: { data: Buffer; fds: number[] },) {
        fds.forEach((fd) => this.fdQ.push(fd));
        try {
          for (const [obj, method, args] of this.parser(data)) {
            const functionActualName = snakePrepend("wl", method);
            params.call?.bind(this)?.(obj, functionActualName, args);
          }
        } catch (err) {
          console.error(err);
          sock.end();
        }
      }.bind(this));
    }.bind(this));
  }

  objects: Map<number, V> = new Map();

  createObjRef(args: Record<string, any>, iface: string, oid: number, parent?: V, version?: number) {
    return this.params.createObjRef.bind(this)(args, iface, oid, parent, version);
  }

  createObject(objRef: V) {
    this.objects.set(objRef.oid, objRef);
    this.emit("new_obj", objRef);

    return objRef;
  }

  parseBlock(ctx: ParsingContext<V>, type: string, arg?: WlArg): any {
    const idx = ctx.idx;
    switch (type) {
      case "int": {
        ctx.idx += 4;
        return read(ctx.buf, idx, true);
      }
      case "uint": {
        ctx.idx += 4;
        return read(ctx.buf, idx);
      }
      case "fixed": {
        ctx.idx += 4;
        return read(ctx.buf, idx, true) / 2 ** 8;
      }
      case "object": {
        if (!arg) throw new Error("Need whole arg to parse object");
        const hypotheticalOID = read(ctx.buf, ctx.idx);
        ctx.idx += 4;
        if (hypotheticalOID === 0 && 'allowNull' in arg && arg.allowNull) {
          return null;
        }
        // const object = this.objects.get(hypotheticalOID);
        return this.objects.get(hypotheticalOID);
      }
      case "new_id": {
        if (!arg) throw new Error("Need whole arg to parse new_id");
        if (!("interface" in arg))
          throw new Error("new_id has no interface attribute");
        const iface = arg.interface;
        if (iface != null) {
          const oid = read(ctx.buf, ctx.idx);

          ctx.idx += 4;
          ctx.callbacks.push(
            (args: Record<string, any>) =>
              (args[arg.name] = this.createObject(this.createObjRef(args, iface, oid, ctx.parent))),
          );
          return;
        } else {
          const ifaceName = this.parseBlock(ctx, "string") as string;
          const ifaceVersion = this.parseBlock(ctx, "uint") as number;
          const oid = this.parseBlock(ctx, "uint") as number;

          const knownVersion = interfaces[ifaceName]?.version;
          if (knownVersion < ifaceVersion) {
            throw new Error(`Of ${ifaceName}: version ${ifaceVersion} is incompatible with version ${knownVersion}`);
          }
          ctx.callbacks.push((args: Record<string, any>) => {
            args[arg.name] = this.createObject(this.createObjRef(args, ifaceName, oid, ctx.parent, ifaceVersion));
          });
          return null;
        }
      }
      case "string": {
        const size = read(ctx.buf, idx);
        ctx.idx += 4;

        const string = ctx.buf.subarray(idx + 4, idx + size + 4 - 1); // -1 for the NUL at the end
        ctx.idx += Math.ceil(size / 4) * 4;
        return string.toString();
      }
      case "array": {
        const size = read(ctx.buf, idx);
        ctx.idx += 4;

        const buffer = ctx.buf.subarray(idx + 4, idx + size + 4);
        ctx.idx += Math.ceil(size / 4) * 4;

        return buffer;
      }
      case "fd": {
        return ctx.fdQ.shift();
      }
      default:
        throw new Error(`While parsing message: unknown type ${type}`);
    }
  }

  *parser(
    buf: Buffer,
    isEvent?: boolean,
  ): Generator<[V, string, Record<string, any>]> {
    let newCommandAt = 0;
    while (newCommandAt < buf.length) {
      const objectId = read(buf, newCommandAt + 0);

      const opcodeAndSize = read(buf, newCommandAt + 4);
      const opcode = opcodeAndSize % 2 ** 16;
      const size = opcodeAndSize >> 16;

      const relevantObject = this.objects.get(objectId);
      if (relevantObject == null)
        throw new Error(
          "Client tried to invoke an operation on an unknown object",
        );

      // console.log(relevantObject);

      const relevantIface = relevantObject.iface;
      const relevantScope =
        interfaces[relevantIface][isEvent ? "events" : "requests"];
      const { name: commandName, args: signature } = relevantScope[opcode];

      const argsResult: Record<string, any> = {};

      let currentIndex = newCommandAt + 8;

      const parsingContext: ParsingContext<V> = {
        buf,
        idx: currentIndex,
        callbacks: [],
        fdQ: this.fdQ,
        parent: relevantObject,
      };

      for (const arg of signature) {
        argsResult[arg.name] = this.parseBlock(parsingContext, arg.type, arg);
      }

      for (const callback of parsingContext.callbacks) {
        callback(argsResult);
      }

      yield [relevantObject, commandName, argsResult];

      newCommandAt += size;
    }
    if (newCommandAt !== buf.length) throw new Error("Possibly missing data");

    this.sendPending();

    // return commands;
  }

  buildBlock(val: any, arg: WlArg, idx: number, buf: Buffer, fds: number[]): number {
    switch (arg.type) {
      case "int": {
        write(val, buf, idx, true);
        return idx + 4;
      }
      case "uint": {
        write(val, buf, idx);
        return idx + 4;
      }
      case "fixed": {
        write(val * 2 ** 8, buf, idx, true);
        return idx + 4;
      }
      case "new_id": // EDIT: Yes, yes it is. Cf. WlDataDevice#wlDataOffer
      case "object": {
        write(arg.allowNull ? val?.oid ?? 0 : val.oid, buf, idx);
        return idx + 4;
      }
      case "string": {
        const size = (1 + val.length) as number;
        const string = val;
        write(size, buf, idx);
        buf.write(string, idx + 4, "utf-8");

        return idx + 4 + Math.ceil(size / 4) * 4;
      }
      case "array": {
        const size = val.length as number;
        const buffer: Buffer = val;
        write(size, buf, idx);
        buffer.copy(buf, idx + 1);

        return idx + 4 + Math.ceil(size / 4) * 4;
      }
      case "fd": {
        fds.push(val);
        return idx;
      }
    }
  }

  getFinalSize(msg: WlMessage, args: Record<string, any>) {
    let result = 0;

    for (const arg of msg.args) {
      if (["int", "uint", "new_id", "object", "fixed"].includes(arg.type)) {
        result += 4;
        continue;
      }
      if (arg.type === "fd") continue;
      result += Math.ceil((args[arg.name].length + 1) / 4) * 4 + 4;
    }

    return result;
  }

  builder(obj: V, eventName: string, args: Record<string, any>): [Buffer, number[]] {
    if (!obj) throw new Error("Attempted to build a command of an inexisting object");

    const msg = interfaces[obj.iface].eventsReverse[eventName];
    const opcode = msg.index;

    const size = this.getFinalSize(msg, args) + 8;
    const result = Buffer.alloc(size);
    const resultFds: number[] = [];
    write(obj.oid, result, 0);
    write(size * 2 ** 16 + opcode, result, 4);

    let currIdx = 8;
    for (let i = 0; i < msg.args.length; i += 1) {
      const arg = msg.args[i];
      const key = snakeToCamel(arg.name);
      if (!Object.hasOwn(args, key)) throw new Error(`Whilst sending ${obj.iface}.${eventName}, ${key} was not found in args`);
      // console.log(args, key);
      currIdx = this.buildBlock(args[key], arg, currIdx, result, resultFds);
    }

    // console.log(size * 2 ** 16 + opcode, result);

    return [result, resultFds];
  }

  static isVersionAccurate(iface: string, version: number, eventName: string): boolean {
    if (!version) return true; // probably...

    const eventObj = interfaces[iface].eventsReverse[eventName];

    if (eventObj.since && version < eventObj.since || eventObj.deprec && version > eventObj.deprec) {
      console.log(eventObj.since, version, eventObj.deprec, eventName, iface);
      return false;
    }

    return true;
  }

  protected buffersSoFar: [Buffer, number[]][] = [];
  // protected immediate?: NodeJS.Immediate;
  addCommand(obj: V, eventName: string, args: Record<string, any>): boolean {
    if (!obj) throw new Error("Attempted to build a command of an inexisting object");

    if (!Connection.isVersionAccurate(obj.iface, obj.version, eventName)) return false;
    const toBeSent = this.builder(obj, eventName, args);

    // console.log(this.connId, "S --> C", Connection.prettyWlObj(obj), eventName);

    this.buffersSoFar.push(toBeSent);
    // if (!this.immediate)
    //   this.immediate = setImmediate((() => this.sendPending()).bind(this));
    // Just checked and setImmediate can tAKE TWELVE MILLISECONDS?? im a dumbass
    // this.socket.write(toBeSent);
    return true;
  }

  sendPending() {
    const resBuf = Buffer.concat(this.buffersSoFar.map(([v]) => v));
    this.socket.write({ data: resBuf, fds: this.buffersSoFar.map(([_, v]) => v).flat(1) });
    // console.log("S2C", resBuf.toString("hex"));

    // console.log('flushed', this.buffersSoFar.length, 'buffers');

    this.buffersSoFar = [];
  }

  destroy(oid: number) {
    this.objects.delete(oid);
    const wlDisplay = this.objects.get(1);
    if (oid < 0xFF000000 && wlDisplay) {
      this.addCommand(wlDisplay, 'deleteId', { id: oid });
    }
  }

  latestServerOid = 0xFF000000;
  createServerOid() {
    return this.latestServerOid++;
  }
}
