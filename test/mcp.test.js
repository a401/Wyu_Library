import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio initializes from another cwd and exposes eight tools without login", { timeout: 15000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    cwd: os.tmpdir(), stderr: "pipe",
    env: {
      WYULIB_USER: "", WYULIB_PASS: "", WYULIB_PASSWORD: "", WYU_USER: "", WYU_PASS: "",
      WYULIB_DELIVERY_EMAIL: "", WYULIB_AUTO_LOGIN: "0"
    }
  });
  const client = new Client({ name: "wyulib-offline-test", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data.toString(); });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      "download_url", "find_best_literature", "get_literature_detail", "login_status",
      "open_login", "request_document_delivery", "search_literature", "submit_document_delivery"
    ]);
    // These fail before any network access or browser launch.
    const missingEmail = await client.callTool({ name: "submit_document_delivery", arguments: { id: "example-record" } });
    const result = JSON.parse(missingEmail.content[0].text);
    assert.equal(result.ok, false);
    assert.match(result.message, /Recipient email is required/);
    const invalidSearch = await client.callTool({ name: "search_literature", arguments: { keyword: "" } });
    assert.equal(invalidSearch.isError, true);
    assert.equal(stderr, "");
  } finally {
    await client.close();
    await transport.close();
  }
});
