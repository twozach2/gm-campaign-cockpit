import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const defaultOperations = {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class AtomicJsonStore {
  constructor({
    file,
    validate = () => true,
    onWarning = (message) => console.error(message),
    operations = defaultOperations,
  }) {
    this.file = path.resolve(file);
    this.validate = validate;
    this.onWarning = onWarning;
    this.operations = operations;
    this.closed = false;
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.lastError = null;
  }

  async load(defaultValue) {
    let raw;
    try {
      raw = await this.operations.readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return cloneJson(defaultValue);
      throw error;
    }

    try {
      const value = JSON.parse(raw);
      if (!this.validate(value)) throw new Error("stored JSON failed validation");
      return value;
    } catch (error) {
      const corruptPath = `${this.file}.${timestamp()}.corrupt`;
      try {
        await this.operations.rename(this.file, corruptPath);
        this.onWarning(
          `Quarantined invalid JSON from ${this.file} to ${corruptPath}: ${error.message}`,
        );
      } catch (quarantineError) {
        this.onWarning(
          `Invalid JSON in ${this.file}; quarantine failed: ${quarantineError.message}`,
        );
      }
      return cloneJson(defaultValue);
    }
  }

  write(value) {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot write closed JSON store: ${this.file}`));
    }

    let serialized;
    try {
      const json = JSON.stringify(value, null, 2);
      if (json === undefined) {
        throw new TypeError("JSON store value is not serializable");
      }
      serialized = `${json}\n`;
    } catch (error) {
      return Promise.reject(error);
    }

    const operation = this.tail.then(() => this.writeSerialized(serialized));
    this.tail = operation.then(
      () => {
        this.lastError = null;
      },
      (error) => {
        this.lastError = error;
      },
    );
    return operation;
  }

  async writeSerialized(serialized) {
    const directory = path.dirname(this.file);
    const temporary = path.join(
      directory,
      `.${path.basename(this.file)}.${process.pid}.${Date.now()}.${++this.sequence}.tmp`,
    );
    let handle = null;

    try {
      await this.operations.mkdir(directory, { recursive: true });
      handle = await this.operations.open(temporary, "w", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.operations.rename(temporary, this.file);
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Preserve the original write error.
        }
      }
      try {
        await this.operations.unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          this.onWarning(
            `Could not remove temporary JSON file ${temporary}: ${cleanupError.message}`,
          );
        }
      }
      throw error;
    }
  }

  async flush() {
    await this.tail;
    if (this.lastError) throw this.lastError;
  }

  async close() {
    this.closed = true;
    await this.flush();
  }
}
