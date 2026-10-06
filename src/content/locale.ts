import type { Persona } from "../persona/schema.js";

/**
 * Local realism for every generated image. Image models fill any gap with their
 * default (a Western room, white hands, a generic café), so each prompt states
 * where on Earth the photo is, what that place really looks like, and whose
 * skin any visible hand belongs to. Persona locations may carry their own
 * `look`; otherwise the cues come from the location's kind and the country.
 */

export type PlaceKind = "home" | "shop" | "mall" | "market" | "street" | "cafe" | "office" | "worship" | "rooftop" | "gym" | "venue" | "outdoors" | "airport";

/** Guess what kind of place a location is from its id and description. */
export function placeKind(id: string, description: string): PlaceKind {
  const t = `${id} ${description}`.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  if (has(/airport|departure|lounge past security|duty[- ]free/)) return "airport";
  // "near electronics stores" is a mall; "a phone shop in the mall" is a shop (singular = this place).
  const thisShop = /\b(shop|store|studio|boutique|kiosk|showroom|counter|stall)\b/;
  if (has(/mall|arcade|plaza|complex/) && !has(thisShop)) return "mall";
  if (has(thisShop) && !has(/coffee shop|barber|salon/)) return "shop";
  if (has(/market/)) return "market";
  if (has(/salon|barber/)) return "shop";
  if (has(/caf[eé]|coffee|restaurant|food court|buffet|eatery/)) return "cafe";
  if (has(/office|agency|desk|cowork/)) return "office";
  if (has(/church|mosque|temple|cathedral|auditorium|worship|ministr/)) return "worship";
  if (has(/rooftop|terrace|balcony|skyline|overlooking/)) return "rooftop";
  if (has(/gym|pitch|turf|track|court|sports club|stadium/)) return "gym";
  if (has(/bar\b|lounge|club|hotel|venue|sports bar/)) return "venue";
  if (has(/apartment|home|house|bedroom|kitchen|living room|compound|flat\b/)) return "home";
  if (has(/street|road|stage|boda|junction|sidewalk/)) return "street";
  return "outdoors";
}

interface Locale {
  country: string;
  people: string;
  kinds: Record<PlaceKind, string>;
  /** Images must never look like this. */
  avoid: string;
}

/**
 * Present-day urban Uganda (Kampala and towns like Mbarara, Jinja, Entebbe):
 * what real homes, shops, streets and venues look like, so a "Kisaasi
 * apartment" or "a phone shop in Pioneer Mall" reads as Kampala at a glance.
 */
const UGANDA: Locale = {
  country: "Kampala, Uganda (East Africa), present day",
  people: "Anyone else in frame is a Black Ugandan (shop attendants, customers, friends, passers-by), dressed the way people in Kampala dress today.",
  kinds: {
    home: "a real Kampala home: glossy ceramic or terrazzo tiled floor (no carpet), painted plastered walls in cream, mint or pastel, aluminium sliding or louvre windows with burglar-proof metal bars and net or patterned curtains, a fabric sofa set with cushions, a low wooden coffee table, a flat TV on a wooden stand, a few potted plants, kitenge or woven accents; through the window a walled compound with a gate, red-earth soil, banana or mango trees and iron-sheet or clay-tile roofs on green hills. Kitchens have a two-burner gas cooker with a gas cylinder, a thermos flask for tea and plastic basins",
    shop: "a real Kampala retail shop, clearly a business and not a home: a compact shop unit with a glass shopfront and the shop name above, glass display counters and glass or melamine shelves packed with stock, products hanging on pegboard hooks, fluorescent tube lighting, glossy tiled floor, branded posters and price tags, an attendant behind the counter and customers browsing; in a mall like Pioneer Mall the shop opens onto a busy narrow corridor lined with similar shop units, glass railings and other shoppers",
    mall: "a busy Kampala shopping mall such as Pioneer Mall, Acacia Mall or Arena Mall: multi-level corridors of small glass-fronted shop units, phone and accessory shops, glass railings, tiled floors, bright fluorescent and LED lighting, signage for local brands and mobile networks (MTN yellow, Airtel red), crowds of shoppers",
    market: "a lively Ugandan open-air market: wooden and tin-roofed stalls, produce piled on tables and sacks (matooke bunches, tomatoes, onions, pineapples, passion fruit), umbrellas, red-earth ground, vendors and shoppers, boda bodas at the edge",
    street: "a real Kampala street: boda boda motorbike taxis, white Toyota matatu taxis with a blue checked stripe, kiosks and shopfronts painted in MTN yellow or Airtel red, roadside vendors, red murram shoulders, power lines, mixed low-rise buildings, hills dotted with houses behind, equatorial sun and lush greenery",
    cafe: "a real Kampala café or restaurant: wooden tables and chairs, local plants, open-air or large windows onto a garden or street, a counter with a coffee machine, Ugandan customers; food and drink look local (African tea, Ugandan coffee, chapati, rolex, samosas, fresh pineapple and passion fruit juice)",
    office: "a real Kampala small office: wooden desks, plastic or office chairs, a ceiling fan or wall AC, calendars and posters on painted walls, tiled floor, louvre windows with bars, a desktop computer and files",
    worship: "a real Ugandan place of worship as it actually looks, respectful and full of local congregants in Sunday best or prayer wear",
    rooftop: "a Kampala rooftop or terrace: a view over the green hills of Kampala covered with red-roofed houses, mid-rise buildings and church spires, plastic or rattan lounge chairs, potted plants, warm string lights at dusk",
    gym: "a Kampala gym or sports ground: simple equipment, painted concrete or rubber floors, local trainers and players; outdoor pitches have artificial turf or dusty red earth and floodlights",
    venue: "a Kampala lounge, bar or hotel terrace: local crowd, plastic or rattan furniture, big screens for football, warm lights, greenery and hills beyond",
    outdoors: "the green, hilly Ugandan outdoors: red-earth paths, banana and mango trees, tropical greenery, jacaranda and flame trees, bright equatorial light",
    airport: "Entebbe International Airport: modern terminal with tiled floors, Ugandan travellers and staff, airline counters, Lake Victoria greenery visible outside",
  },
  avoid: "no Western suburban interiors, no carpeted floors, fireplaces or wooden-floor lofts, no snow or autumn leaves, no American or European street furniture, no white or East Asian people unless the persona is, no generic stock-photo look",
};

/** The locale for a persona: Uganda when the home or trends region is Ugandan, else none (stay generic). */
export function localeFor(p: Persona): Locale | undefined {
  const where = `${p.identity.location} ${p.trends.region ?? ""}`;
  return /uganda|kampala|\bUG\b|mbarara|jinja|entebbe|gulu/i.test(where) ? UGANDA : undefined;
}

/**
 * Lines added to every image prompt: the country, the place's real look, who
 * else may be in frame, the skin tone of any visible hand, and what to avoid.
 */
export function localeLines(p: Persona, loc: { id: string; description: string; look?: string } | undefined, includeCharacter: boolean): string[] {
  const l = localeFor(p);
  const ch = p.visual.character;
  const out: string[] = [];
  if (l) out.push(`Setting: ${l.country}. Everything in frame must read as this real place.`);
  if (loc) {
    const kind = placeKind(loc.id, loc.description);
    const look = loc.look?.trim() || (l ? l.kinds[kind] : "");
    if (look) out.push(`What this place really looks like: ${look}.`);
    if (kind === "shop" && p.brand && /shop|store|studio|boutique|counter|showroom/i.test(`${loc.id} ${loc.description}`)) {
      out.push(`The stock on display is ${p.brand.name}'s: ${p.brand.category}${p.brand.products.length ? ` (${p.brand.products.slice(0, 4).join("; ")})` : ""}.`);
    }
  }
  if (!includeCharacter) {
    // Hands, feet or a shoulder in a POV shot are still this person, never a stranger.
    out.push(`Any hands, arms or feet in frame belong to ${p.identity.name}: ${ch.skin_tone} skin${ch.signature_accessories.length ? `, wearing ${ch.signature_accessories.join(" and ")}` : ""}.`);
  }
  if (l) out.push(l.people);
  if (l) out.push(`Avoid: ${l.avoid}.`);
  return out;
}
