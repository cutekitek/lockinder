export const ROLES = ['Carry', 'Support', 'Tank', 'Initiator', 'Flex'] as const;
export const LANGUAGES = ['en', 'ru', 'uk', 'be', 'pl', 'de', 'fr', 'es', 'pt', 'it', 'tr', 'ar', 'zh', 'ja', 'ko', 'hi', 'id', 'vi', 'th', 'nl', 'sv', 'fi', 'da', 'no', 'cs', 'sk', 'ro', 'hu', 'bg', 'el', 'he', 'fa', 'kk', 'uz', 'az', 'ka', 'hy', 'lt', 'lv', 'et', 'sr', 'hr', 'sl', 'bs', 'sq', 'mk', 'ms', 'tl', 'bn', 'ta', 'te', 'ur', 'sw', 'af', 'is', 'ga', 'mt', 'cy', 'eu', 'ca', 'gl'] as const;
export type Locale = 'en' | 'ru';
export type Hero = { id: number; name: string; image: string; portrait: string };
export type RankAsset = { tier: number; name: string; image: string; divisions: number[] };
export type Catalog = { heroes: Hero[]; ranks: RankAsset[]; stale: boolean };
export type Player = {
  id: string; name: string; avatar: string; country: string; languages: string[]; roles: string[];
  heroes: number[]; bio: string; tier: number | null; division: number | null;
  rankFetchedAt: number | null; rankError: string | null;
};
export type Filters = { minRank: number | null; maxRank: number | null; roles: string[] };
export function rankPosition(tier: number | null, division: number | null) {
  return tier && division ? (tier - 1) * 6 + division - 1 : null;
}
export function orderPlayers(viewer: Player, players: Player[], filters: Filters): Player[] {
  const shared = (p: Player) => p.languages.some(l => viewer.languages.includes(l));
  const position = (p: Player) => rankPosition(p.tier, p.division);
  const viewerRank = position(viewer);
  return players.filter(p => {
    const rank = position(p);
    return (!filters.roles.length || filters.roles.some(r => p.roles.includes(r))) &&
      (filters.minRank === null || (rank !== null && rank >= filters.minRank)) &&
      (filters.maxRank === null || (rank !== null && rank <= filters.maxRank));
  }).sort((a, b) => {
    const language = Number(shared(b)) - Number(shared(a));
    if (language) return language;
    const ar = position(a), br = position(b);
    const unknown = Number(ar === null) - Number(br === null);
    if (unknown) return unknown;
    if (viewerRank !== null && ar !== null && br !== null) {
      const distance = Math.abs(ar - viewerRank) - Math.abs(br - viewerRank);
      if (distance) return distance;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
