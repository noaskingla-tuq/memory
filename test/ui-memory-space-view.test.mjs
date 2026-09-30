import assert from "node:assert/strict";
import test from "node:test";
import { count } from "./homeFixtures.mjs";
import { AGENT_ID, EMPTY_STATS, NOW, dayKey, makeStats, opened, sectionOf, ui } from "./spaceFixtures.mjs";

const { STRINGS } = ui;

const columnsIn = (markup) => count(markup, /<i[ >]/gu);

test("opening an agent asks ui.agentStats once with the agent id and the local offset, and fills the header", async () => {
  const { client, targets, space } = await opened();
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, "ui.agentStats");
  assert.deepEqual(Object.keys(client.calls[0].params).sort(), ["agentId", "tzOffsetMin"]);
  assert.equal(client.calls[0].params.agentId, AGENT_ID);
  assert.equal(client.calls[0].params.tzOffsetMin, -new Date(NOW).getTimezoneOffset());
  assert.ok(!Object.is(client.calls[0].params.tzOffsetMin, -0), "a zero offset must not travel as -0");
  assert.equal(client.calls[0].options.key, "space", "the space request has its own key so the status poll and the overview never supersede it");
  assert.equal(space.view().phase, "ready");
  assert.equal(targets.title.textContent, "開發工程師");
  assert.equal(targets.id.textContent, AGENT_ID);
  assert.ok(targets.avatar.innerHTML.includes(">開<"), "the avatar letter is the first character of the name");
  const meta = targets.meta.textContent;
  for (const part of ["部門 軟體開發組", "職稱 寫程式的人", "累積 22 筆", "最早 ", "最近寫入 "]) assert.ok(meta.includes(part), `${part} in ${meta}`);
  assert.ok(/最早 \d{4}-\d{2}-\d{2}/u.test(meta));
});

test("a ready page draws every section: spaces, days, hours and weekdays, tools, repeated requests and the four representative memories", async () => {
  const { targets } = await opened();
  const body = targets.body.innerHTML;
  for (const id of ["space-h-spaces", "space-h-days", "space-h-hours", "space-h-tools", "space-h-repeat", "space-h-rep"]) assert.ok(body.includes(`id="${id}"`), id);
  const spaces = sectionOf(body, "space-h-spaces");
  assert.ok(spaces.includes(STRINGS["space.spaces.personal"]) && spaces.includes("12 筆"));
  assert.ok(spaces.includes(">官網改版<") && spaces.includes("7 筆") && spaces.includes(">專案 proj-unn<") && spaces.includes("3 筆"));
  assert.ok(spaces.includes('data-scope="project" data-project-id="proj-alpha"') && spaces.includes('data-scope="personal" data-project-id=""'));
  assert.ok(!spaces.includes(STRINGS["space.spaces.noProject"]), "with projects there is no explanation");
  const tools = sectionOf(body, "space-h-tools");
  assert.ok(tools.includes("claude / opus-4") && tools.includes("64%") && tools.includes("27%") && tools.includes(STRINGS["space.tools.unknown"]));
  const repeat = sectionOf(body, "space-h-repeat");
  assert.ok(repeat.includes("整理本週工作") && repeat.includes("5 次") && repeat.includes("檢查結帳流程") && repeat.includes("2 次") && repeat.includes(STRINGS["space.repeat.note"]));
  const reps = sectionOf(body, "space-h-rep");
  assert.equal(count(reps, /<article class="rep"/gu), 4);
  assert.ok(reps.includes(STRINGS["space.rep.note"]));
  assert.equal(count(body, /<h3 /gu), 6);
});

test("the project part is shown even when it is empty, with the plain reason (D9)", async () => {
  const stats = makeStats({ namespaces: [makeStats().namespaces[0]] });
  const { targets } = await opened(stats);
  const spaces = sectionOf(targets.body.innerHTML, "space-h-spaces");
  assert.ok(spaces.includes(`>${STRINGS["space.spaces.projects"]}</h4>`));
  assert.ok(spaces.includes(STRINGS["space.spaces.noProject"]));
  assert.equal(count(spaces, /class="bar-row"/gu), 1, "only the personal row");
});

test("the 30-day chart has 30 columns, marks empty days, and says the total and the busiest day to a screen reader", async () => {
  const stats = makeStats();
  const { targets } = await opened(stats);
  const days = sectionOf(targets.body.innerHTML, "space-h-days");
  assert.equal(columnsIn(days), 30);
  const zero = stats.byDay30.filter((day) => day.count === 0).length;
  assert.equal(count(days, /<i class="zero"/gu), zero);
  const sum = stats.byDay30.reduce((total, day) => total + day.count, 0);
  const peak = Math.max(...stats.byDay30.map((day) => day.count));
  const peakDay = stats.byDay30.find((day) => day.count === peak).date;
  const month = Number(peakDay.slice(5, 7));
  const dom = Number(peakDay.slice(8, 10));
  assert.ok(days.includes(`aria-label="近 30 天共寫入 ${sum} 筆，最多的一天是 ${month}/${dom}（${peak} 筆）"`), days.slice(0, 400));
  assert.ok(days.includes(`近 30 天最多一天寫入 ${peak} 筆`));
  assert.ok(days.includes(`>${STRINGS["space.days.today"]}<`));
  const first = dayKey(29);
  assert.ok(days.includes(`<span>${Number(first.slice(5, 7))}/${Number(first.slice(8, 10))}</span>`), "the left end of the axis is the first day of the window");
  assert.ok(/title="\d+\/\d+：\d+ 筆"/u.test(days), "each column has a tooltip");
});

test("a space with no writes in the last 30 days draws a flat chart and says so instead of an empty picture", async () => {
  const { targets } = await opened(EMPTY_STATS);
  const days = sectionOf(targets.body.innerHTML, "space-h-days");
  assert.equal(columnsIn(days), 30);
  assert.equal(count(days, /<i class="zero"/gu), 30);
  assert.ok(days.includes(STRINGS["space.days.ariaNone"]) && days.includes(STRINGS["space.days.none"]));
  const rhythm = sectionOf(targets.body.innerHTML, "space-h-hours");
  assert.ok(rhythm.includes(STRINGS["space.hours.ariaNone"]) && rhythm.includes(STRINGS["space.weekday.ariaNone"]));
  const body = targets.body.innerHTML;
  assert.ok(sectionOf(body, "space-h-tools").includes(STRINGS["space.tools.empty"]));
  assert.ok(sectionOf(body, "space-h-repeat").includes(STRINGS["space.repeat.empty"]));
  assert.ok(sectionOf(body, "space-h-rep").includes(STRINGS["space.rep.empty"]));
  assert.ok(!/undefined|NaN|null/u.test(body));
});

test("the hours chart has 24 columns and the weekday chart 7, each with its axis and a spoken peak", async () => {
  const { targets } = await opened();
  const rhythm = sectionOf(targets.body.innerHTML, "space-h-hours");
  assert.equal(columnsIn(rhythm), 31);
  assert.ok(rhythm.includes('aria-label="一天 24 小時的寫入分布，最多的是 18 點（11 筆）"'));
  assert.ok(rhythm.includes('aria-label="一週七天的寫入分布，最多的是週三（7 筆）"'));
  for (const label of ["0 點", "12 點", "23 點"]) assert.ok(rhythm.includes(`<span>${label}</span>`), label);
  for (const day of ["日", "一", "二", "三", "四", "五", "六"]) assert.ok(rhythm.includes(`<span>${day}</span>`), day);
  assert.ok(rhythm.includes('title="18 點：11 筆"') && rhythm.includes('title="週三：7 筆"'));
  assert.equal(count(rhythm, /<i class="zero"/gu), 14 + 1, "hours 0..8 and 19..23 are empty, and so is Sunday");
});
