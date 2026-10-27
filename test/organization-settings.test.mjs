import assert from "node:assert/strict";
import test from "node:test";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";

test("organization scheduling defaults consistently to daily at local 02:00", () => {
  assert.deepEqual(readOrganizationSettings(), {
    enabled: true,
    providerId: "",
    modelId: "",
    contextBudget: 32768,
    frequency: "daily",
    dailyTime: "02:00",
  });
});

test("organization scheduling defensively normalizes invalid legacy frequency and daily time", () => {
  assert.deepEqual(readOrganizationSettings({ organizationFrequency: "weekly", organizationDailyTime: "24:00" }), {
    enabled: true,
    providerId: "",
    modelId: "",
    contextBudget: 32768,
    frequency: "daily",
    dailyTime: "02:00",
  });
  assert.equal(readOrganizationSettings({ organizationFrequency: "immediate", organizationDailyTime: "09:05" }).frequency, "immediate");
  assert.equal(readOrganizationSettings({ organizationFrequency: "immediate", organizationDailyTime: "09:05" }).dailyTime, "09:05");
});

test("daily time accepts only strict 24-hour HH:mm values", () => {
  for (const dailyTime of ["00:00", "08:05", "23:59"]) assert.equal(readOrganizationSettings({ organizationDailyTime: dailyTime }).dailyTime, dailyTime);
  for (const dailyTime of ["0:00", "24:00", "12:60", " 02:00", "02:00 ", 200]) assert.equal(readOrganizationSettings({ organizationDailyTime: dailyTime }).dailyTime, "02:00");
});
