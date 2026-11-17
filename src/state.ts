import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SymbolState } from "./core/types.js";

export interface StateFile {
  version: 1;
  symbols: Record<string, SymbolState>;
}

export async function loadState(file: string): Promise<StateFile> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as StateFile;
    if (data.version !== 1 || typeof data.symbols !== "object") throw new Error("版本不兼容");
    return data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, symbols: {} };
    throw new Error(`状态文件 ${file} 损坏：${(e as Error).message}。可删除后重新运行（会丢失已触发档位记录）`);
  }
}

/** 先写临时文件再改名，避免进程中断时写坏状态文件 */
export async function saveState(file: string, state: StateFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
