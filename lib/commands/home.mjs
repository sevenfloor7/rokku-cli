// The phone's Home: which creations are on it, in what order, at what size and version.
import {fail, usage, request, print, table, confirm} from "../core.mjs";
import {findCreation} from "../creations.mjs";

// The App keeps each item's place as "grid-v1-<8 digits>" and lays Home out in that order, items with
// a place first, then items without one in their stored order (backend home_preview_order).
const SLOT = /^grid-v1-\+?(\d+)$/;
const slot = item => SLOT.exec(item.home_order ?? "")?.[1];
function ordered(items) {
  const byOrder = [...items].sort((a, b) => (a.home_order !== null) - (b.home_order !== null) || (a.home_order ?? "").localeCompare(b.home_order ?? ""));
  return byOrder.sort((a, b) => (slot(a) === undefined) - (slot(b) === undefined) || Number(slot(a) ?? 0) - Number(slot(b) ?? 0));
}

async function homeItem(config, ref) {
  const [home, creation] = await Promise.all([request(config, "GET /v1/home/artifacts"), findCreation(config, ref, {exact: true})]);
  const item = home.items.find(entry => entry.artifact_id === creation.artifact_id);
  if (!item) fail(`${creation.title} is not on your Home`);
  return {home, item};
}

const patch = (config, home, item, change) => request(config, "PATCH /v1/home/artifacts/{artifact_id}", {
  params: {artifact_id: item.artifact_id}, body: {expected_revision: home.revision, ...change}});
// Rokku ranks the item the way the Agent places one (home_position): it takes that place and every
// other item keeps its relative order. Place N is before the item now N-th among the others.
function position(home, item, index) {
  const others = ordered(home.items).filter(entry => entry.artifact_id !== item.artifact_id);
  if (index === 0) return "top";
  if (index >= others.length) return "bottom";
  return {relation: "before", artifact_id: others[index].artifact_id};
}

const SIZES = {s: "icon", m: "card", l: "full width"};

export const commands = {
  home: {
    usage: "rokku home [list | add <creation> [--size s|m|l] [--version N] | size <creation> s|m|l | move <creation> --top|--bottom|--slot N | version <creation> N | remove <creation>]",
    async run(config, [verb = "list", ref, value], flags) {
      if (verb === "list") {
        const home = await request(config, "GET /v1/home/artifacts");
        if (flags.raw) return print(home);
        // Listed in Home order; a creation made a moment ago may not be here yet (Rokku adds it shortly).
        return print(table(ordered(home.items), [["title", i => i.title], ["size", i => `${i.home_size} (${SIZES[i.home_size]})`],
          ["version", i => `v${i.artifact_version}`], ["id", i => i.artifact_id]]));
      }
      if (!ref) usage(`Usage: rokku home ${verb} <creation> ...`);
      if (verb === "add") {
        // Adding is the same PATCH as changing an item: a creation not on Home yet is placed there.
        const [home, creation] = await Promise.all([request(config, "GET /v1/home/artifacts"), findCreation(config, ref, {exact: true})]);
        if (home.items.some(entry => entry.artifact_id === creation.artifact_id)) fail(`${creation.title} is already on Home; change it with rokku home size/move/version`);
        const size = flags.size === undefined ? undefined : String(flags.size);
        if (size !== undefined && !(size in SIZES)) usage("--size is s (icon), m (card) or l (full width)");
        // Home shows the version that is running; a newer one still deploying is refused by the server.
        const version = flags.version === undefined ? creation.active_version ?? creation.latest_version : Number(flags.version);
        if (!Number.isInteger(version) || version < 1) usage("--version takes a version number");
        try {
          await request(config, "PATCH /v1/home/artifacts/{artifact_id}", {params: {artifact_id: creation.artifact_id},
            body: {expected_revision: home.revision, artifact_version: version, ...(size ? {home_size: size} : {})}});
        } catch (error) {
          if (error.details?.reason === "version_not_live") fail(`${creation.title} v${version} is not live yet (its deployment hasn't finished); wait a moment and retry` +
            (creation.active_version && creation.active_version !== version ? `, or add the running version: rokku home add ${creation.artifact_id} --version ${creation.active_version}` : ""));
          if (error.details?.reason !== "home_card_required") throw error;
          fail(`${creation.title} v${version} has no Home card, so it can't go on Home. Add Card.tsx (manifest rn_source and rn_card), then rokku push`);
        }
        return print(`${creation.title} v${version} is on your Home${size ? ` (${SIZES[size]})` : ""}.`);
      }
      const {home, item} = await homeItem(config, ref);
      if (verb === "size") {
        if (!(value in SIZES)) usage("Usage: rokku home size <creation> s|m|l   (s icon, m card, l full width)");
        await patch(config, home, item, {home_size: value});
        return print(`${item.title} is now ${value} (${SIZES[value]}) on your Home.`);
      }
      if (verb === "move") {
        const chosen = [flags.top && 0, flags.bottom && home.items.length, flags.slot !== undefined && Number(flags.slot)].filter(v => v !== false && v !== undefined);
        if (chosen.length !== 1 || !Number.isInteger(chosen[0]) || chosen[0] < 0)
          usage("Usage: rokku home move <creation> --top | --bottom | --slot N   (N is the place in Home order, 0 = first)");
        await patch(config, home, item, {home_position: position(home, item, chosen[0])});
        return print(`Moved ${item.title}; the App fits the rest of Home around it.`);
      }
      if (verb === "version") {
        const version = Number(value);
        if (!Number.isInteger(version) || version < 1) usage("Usage: rokku home version <creation> <N>");
        await patch(config, home, item, {artifact_version: version});
        return print(`Home shows ${item.title} v${version}.`);
      }
      if (verb === "remove") {
        await confirm(flags, `Taking ${item.title} off your Home`, ` (rokku home add ${item.artifact_id} puts it back)`);
        await request(config, "DELETE /v1/home/artifacts/{artifact_id}", {params: {artifact_id: item.artifact_id}, query: {expected_revision: home.revision}});
        return print(`${item.title} is off your Home. The creation itself is kept; put it back with: rokku home add ${item.artifact_id}`);
      }
      usage(`Unknown home verb "${verb}"`);
    },
  },
};
