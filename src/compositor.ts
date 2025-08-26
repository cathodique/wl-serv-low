import { rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { Connection, ObjectReference } from "./connection.js";
import { UServer, USocket } from "@cathodique/usocket";
import { EventEmitter } from "node:stream";

interface CompositorParams<V extends ObjectReference, U extends Connection<V>, T extends Compositor<V, U>> {
  socketPath: string;
  createConnection: (this: T, connId: number, socket: USocket) => U;
}

export class Compositor<V extends ObjectReference, U extends Connection<V>> extends EventEmitter {
  server: UServer;
  closed: boolean = true;
  currConnId = 0;

  params: CompositorParams<V, U, Compositor<V, U>>;

  connections: Map<number, U> = new Map();

  constructor(params: CompositorParams<V, U, Compositor<V, U>>) {
    super();

    this.params = params;

    // Create a server
    this.server = new UServer();
    this.server.on(
      "connection",
      function (this: Compositor<V, U>, socket: USocket) {
        this.emit('connection', this.params.createConnection.bind(this)(this.currConnId, socket));
        this.currConnId += 1;
      }.bind(this),
    );
  }

  close() {
    if (this.closed) return;
    if (this.params.socketPath) {
      rmSync(this.params.socketPath);
      rmSync(`${this.params.socketPath}.lock`);
    }
    this.closed = true;
  }

  start() {
    if (!this.closed) return;
    this.closed = false;
    return new Promise<void>(
      async function (this: Compositor<V, U>, r: () => void) {
        // Listen on the socket path
        this.server.listen(
          this.params.socketPath,
          async function (this: Compositor<V, U>) {
            const fileHandle = await fsp.open(`${this.params.socketPath}.lock`, "a");
            fileHandle.close();

            this.emit('ready');
          }.bind(this),
        );
      }.bind(this),
    );
  }
}
