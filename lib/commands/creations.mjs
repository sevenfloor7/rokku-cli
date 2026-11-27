// Creation lifecycle beyond source: restore an old version, trash and untrash, the public link, usage.
import {fail, usage, request, print, table, when} from "../core.mjs";
import {findCreation, forgetSession} from "../creations.mjs";
import {deployed} from "../source.mjs";

const of = creation => ({artifact_id: creation.artifact_id});

export const commands = {
  "restore-version": {
    usage: "rokku restore-version <creation> <version>     publish an old version's source as the newest version",
    async run(config, [ref, version]) {
      if (!Number.isInteger(Number(version)) || Number(version) < 1) usage("Usage: rokku restore-version <creation> <version>");
      const creation = await findCreation(config, ref, {exact: true});
      const result = await request(config, "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/restore-version", {params: of(creation),
        body: {source_version: Number(version), expected_latest_version: creation.latest_version}});
      // Like push, a dynamic app's restored version is deployed; the answer says how far that got.
      await forgetSession(config, creation);
      print(`${creation.title}: v${version} is restored as v${result.artifact_version}${deployed(result)}.`);
    },
  },
  trash: {
    usage: "rokku trash <creation>                         move a creation to the trash (rokku untrash brings it back)",
    async run(config, [ref]) {
      const creation = await findCreation(config, ref, {exact: true});
      const result = await request(config, "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/trash", {params: of(creation),
        body: {expected_lifecycle_revision: creation.lifecycle_revision}});
      print(`${creation.title} is in the trash${result.purge_after ? ` until ${when(result.purge_after)}` : ""}. Bring it back with: rokku untrash ${creation.artifact_id}`);
    },
  },
  untrash: {
    usage: "rokku untrash <creation>                       restore a creation from the trash",
    async run(config, [ref]) {
      const creation = await findCreation(config, ref, {exact: true, lifecycle: "trashed"});
      if (creation.can_restore === false) fail(`${creation.title} can no longer be restored (${creation.deletion_status ?? "deleted"})`);
      await request(config, "POST /v1/agents/{agent_id}/artifacts/{artifact_id}/restore", {params: of(creation),
        body: {expected_lifecycle_revision: creation.lifecycle_revision}});
      print(`${creation.title} is back.`);
    },
  },
  link: {
    usage: "rokku link <creation> [--on | --off]   show, create or turn off the creation's public link",
    async run(config, [ref], flags) {
      const creation = await findCreation(config, ref, {exact: flags.on || flags.off});
      const route = "/v1/agents/{agent_id}/artifacts/{artifact_id}/public-publication";
      let current = null;
      try { current = await request(config, `GET ${route}`, {params: of(creation)}); }
      catch (error) {
        if (error.details?.reason === "feature_disabled") fail("Public links are not turned on for your Rokku account yet; nothing changed");
        if (error.code !== 1002 && !/not found/i.test(error.message)) throw error;
      }
      if (!flags.on && !flags.off) {
        if (!current || current.state !== "active") return print(`${creation.title} has no public link. Make one with: rokku link ${creation.artifact_id} --on`);
        return print(`${current.public_url}  (opens the version that is running)`);
      }
      const result = await request(config, `PUT ${route}`, {params: of(creation),
        body: {expected_revision: current?.revision ?? 0, state: flags.off ? "revoked" : "active"}});
      print(result.state === "active" ? `Anyone with this link can open ${creation.title}: ${result.public_url}` :
        `${creation.title}'s public link is off; the old link stops working.`);
    },
  },
  usage: {
    usage: "rokku usage <creation> [--month YYYY-MM]       this month's requests, data reads/writes and deployments",
    async run(config, [ref], flags) {
      const creation = await findCreation(config, ref);
      const month = flags.month === undefined ? undefined : String(flags.month);
      if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) usage("--month looks like 2026-11");
      const result = await request(config, "GET /v1/agents/{agent_id}/artifacts/{artifact_id}/usage", {params: of(creation),
        query: {month: month && `${month}-01`}});
      if (flags.raw) return print(result);
      print(`${creation.title}, month from ${result.month_start}:\n` + table(result.dimensions, [
        ["dimension", d => d.dimension], ["owner", d => d.owner], ["public", d => d.public], ["status", d => d.status]]));
    },
  },
};
