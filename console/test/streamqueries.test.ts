// Host test for the flow-controlled streamer's failure handling.
// Run: cd console && npx tsx test/streamqueries.test.ts
import { streamQueries, type SendResult, type StreamItem } from "../src/hooks/usePlotter.ts";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${extra ? `   ${extra}` : ""}`);
  if (!cond) fails++;
};
const items: StreamItem[] = ["a", "b", "c", "d", "e"].map((q) => ({ query: q }));
const handlers = (sendRaw: (ep: string) => Promise<SendResult>) => ({
  sendRaw, getPending: async () => 0, isCancelled: () => false, pushLog: () => {},
});

async function main() {
  console.log("[1] transient 'error' is retried, never dropped");
  {
    const attempts: string[] = [];
    let errBudget = 4;   // first 4 sends fail transiently, then all succeed
    const r = await streamQueries(items, handlers(async (ep) => {
      attempts.push(ep);
      if (errBudget > 0) { errBudget--; return "error"; }
      return "ok";
    }));
    ok("all 5 items sent (none dropped)", r.sent === 5, `sent=${r.sent}`);
    ok("no errors counted for transients", r.errors === 0, `errors=${r.errors}`);
    ok("not stopped", r.stopped === false);
    ok("retried (more attempts than items)", attempts.length > 5, `attempts=${attempts.length}`);
    // first item 'a' was retried until ok before 'b' was attempted
    ok("retries the SAME item (order preserved)", attempts.indexOf("b") > attempts.lastIndexOf("a") - 1 && attempts[0] === "a");
  }

  console.log("[2] genuine 'rejected' is skipped (counted, advances)");
  {
    const r = await streamQueries(items, handlers(async (ep) => (ep === "c" ? "rejected" : "ok")));
    ok("all 5 advanced", r.sent === 5, `sent=${r.sent}`);
    ok("1 rejection counted", r.errors === 1, `errors=${r.errors}`);
  }

  console.log("[3] clean run");
  {
    const r = await streamQueries(items, handlers(async () => "ok"));
    ok("sent 5, 0 errors", r.sent === 5 && r.errors === 0);
  }

  console.log("[4] batch path: enqueues in one request, retries transient");
  {
    const big = Array.from({ length: 200 }, (_, k) => ({ query: `line${k}` }));
    let calls = 0; let total = 0; let failOnce = true;
    const r = await streamQueries(big, {
      sendRaw: async () => "ok",
      getPending: async () => 0,
      isCancelled: () => false,
      pushLog: () => {},
      sendBatch: async (q) => {
        calls++;
        if (failOnce && calls === 2) { failOnce = false; return "error"; }   // one transient blip
        total += q.length;
        return { accepted: q.length, rejected: 0 };
      },
    });
    ok("all 200 sent", r.sent === 200, `sent=${r.sent}`);
    ok("used few requests (batched)", calls < 20, `calls=${calls}`);
    ok("transient blip didn't drop any", total === 200, `total=${total}`);
  }

  console.log("[5] batch path: counts genuine rejections, advances");
  {
    const r = await streamQueries(items, {
      sendRaw: async () => "ok", getPending: async () => 0, isCancelled: () => false, pushLog: () => {},
      sendBatch: async (q) => ({ accepted: q.length - 1, rejected: 1 }),   // one genuine reject in the batch
    });
    ok("advanced past whole batch", r.sent === 5);
    ok("rejection counted", r.errors === 1, `errors=${r.errors}`);
  }

  console.log(`\n${fails ? `TESTS FAILED (${fails})` : "ALL TESTS PASSED"}`);
  process.exit(fails ? 1 : 0);
}
main();
