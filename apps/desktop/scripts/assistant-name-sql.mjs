#!/usr/bin/env node
/**
 * The platform's mirror of the assistant-name rules (atum-platform P1), generated from
 * shared/matrix-assistant-name.ts so the two cannot drift: the SQL functions, or the rule set
 * as JSON. Verify a regenerated mirror with scripts/assistant-name-sql-parity.mjs.
 *
 *   node scripts/assistant-name-sql.mjs                 # SQL into atum_private
 *   node scripts/assistant-name-sql.mjs --schema other  # SQL into another schema
 *   node scripts/assistant-name-sql.mjs --json          # the machine-readable rule set
 *
 * Node 23.6 or later (it imports the TypeScript module directly). Postgres 13 or later, UTF8.
 */
import * as N from '../shared/matrix-assistant-name.ts'

const hex = cp => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
const range = ([low, high]) => (low === high ? hex(low) : `${hex(low)}..${hex(high)}`)
const are = cp =>
  cp <= 0xffff
    ? `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`
    : `\\U${cp.toString(16).toUpperCase().padStart(8, '0')}`
const body = ranges => ranges.map(([low, high]) => (low === high ? are(low) : `${are(low)}-${are(high)}`)).join('')
const quote = text => `'${text.replace(/'/g, "''")}'`

/** The skeleton of a Latin text, as the module computes it for Atum's own names. */
function skeleton(text) {
  let key = ''

  for (const char of text.normalize('NFD').replace(/\p{M}/gu, '')) {
    key += N.ASSISTANT_NAME_SKELETON_LETTERS[char] ?? char
  }

  key = key.toLowerCase()

  for (const [from, to] of N.ASSISTANT_NAME_FOLD_MERGES) {
    key = key.split(from).join(to)
  }

  return key
}

/** Emoji characters the server accepts: Emoji and Extended_Pictographic, minus the framed
 * letters and keycaps (ASSISTANT_NAME_LETTER_EMOJI) and the check marks. */
function pictographs() {
  const checks = new Set([...N.ASSISTANT_NAME_CHECK_MARKS].map(char => char.codePointAt(0)))
  const ranges = []

  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      continue
    }

    const char = String.fromCodePoint(codePoint)

    if (
      !/\p{Emoji}/u.test(char) ||
      !/\p{Extended_Pictographic}/u.test(char) ||
      checks.has(codePoint) ||
      N.ASSISTANT_NAME_LETTER_EMOJI.some(([low, high]) => codePoint >= low && codePoint <= high)
    ) {
      continue
    }

    const last = ranges.at(-1)

    if (last && last[1] === codePoint - 1) {
      last[1] = codePoint
    } else {
      ranges.push([codePoint, codePoint])
    }
  }

  return ranges
}

const REGIONAL_A = 0x1f1e6
const regional = letter => String.fromCodePoint(REGIONAL_A + letter.charCodeAt(0) - 0x61)

/** The recommended (RGI) flags: two regional indicators, as their two letters ("vn"). */
function flagPairs() {
  const pairs = []

  for (let first = 0; first < 26; first += 1) {
    for (let second = 0; second < 26; second += 1) {
      const letters = String.fromCharCode(0x61 + first, 0x61 + second)

      if (/^\p{RGI_Emoji}$/v.test(regional(letters[0]) + regional(letters[1]))) {
        pairs.push(letters)
      }
    }
  }

  return pairs
}

/** The recommended tag-sequence flags (England, Scotland, Wales): 🏴, tag letters, cancel tag. */
const TAG_FLAGS = ['gbeng', 'gbsct', 'gbwls']
const tagFlag = letters =>
  String.fromCodePoint(0x1f3f4, ...[...letters].map(letter => 0xe0000 + letter.charCodeAt(0)), 0xe007f)

for (const letters of TAG_FLAGS) {
  if (!/^\p{RGI_Emoji}$/v.test(tagFlag(letters))) {
    throw new Error(`not a recommended flag in this Node's Unicode data: ${letters}`)
  }
}

/** The allowed Latin letters of one case (`assistantNameLetterCase`), as code point ranges. */
function caseRanges(wanted) {
  const ranges = []

  for (const [low, high] of N.ASSISTANT_NAME_LETTERS.latin) {
    for (let codePoint = low; codePoint <= high; codePoint += 1) {
      if (N.assistantNameLetterCase(String.fromCodePoint(codePoint)) !== wanted) {
        continue
      }

      const last = ranges.at(-1)

      if (last && last[1] === codePoint - 1) {
        last[1] = codePoint
      } else {
        ranges.push([codePoint, codePoint])
      }
    }
  }

  return ranges
}

const skeletons = names => names.map(skeleton)

/** The machine-readable rule set (for packages/protocol and the migration's review). */
export function assistantNameRules() {
  return {
    version: 6,
    source: 'atum-app apps/desktop/shared/matrix-assistant-name.ts',
    unicode: process.versions.unicode,
    maxCodePoints: N.ASSISTANT_NAME_MAX,
    normalize: [
      'NFC',
      'U+0009..U+000D and every \\p{Zs} -> U+0020, runs collapsed, leading and trailing U+0020 removed',
      'units: an emoji (RGI_Emoji, or one Emoji and Extended_Pictographic code point with an optional U+FE0E/U+FE0F) or one code point',
      'NFKC on every run of text between emoji (an emoji keeps its own form)',
      'punctuationVariants mapped, spaces collapsed and trimmed again; the result is stored (NFC)'
    ],
    allowed: {
      latin: N.ASSISTANT_NAME_LETTERS.latin.map(range),
      han: N.ASSISTANT_NAME_LETTERS.han.map(range),
      kana: N.ASSISTANT_NAME_LETTERS.kana.map(range),
      hangul: N.ASSISTANT_NAME_LETTERS.hangul.map(range),
      digits: N.ASSISTANT_NAME_DIGITS.map(range),
      space: 'U+0020',
      punctuation: N.ASSISTANT_NAME_PUNCTUATION,
      emoji:
        'an RGI emoji (UTS #51), or one Emoji and Extended_Pictographic code point with an optional U+FE0E/U+FE0F, none of whose code points is in refused.letterEmoji or refused.checkMarks',
      serverEmojiPictographs: pictographs().map(range),
      serverEmoji:
        'serverEmojiPictographs with an optional U+FE0E/U+FE0F and skin tone, joined by U+200D; one of flags (two regional indicators); one of tagFlags; or a lone skin tone. ZWJ joins are the one place the server is looser than the desktop (any join of allowed pictographs, which draws as pictographs, never as a letter)',
      flags: flagPairs(),
      tagFlags: TAG_FLAGS.map(letters => `U+1F3F4 ${letters} U+E007F`)
    },
    punctuationVariants: Object.fromEntries(
      Object.entries(N.ASSISTANT_NAME_PUNCTUATION_VARIANTS).map(([from, to]) => [hex(from.codePointAt(0)), to])
    ),
    refused: {
      checkMarks: [...N.ASSISTANT_NAME_CHECK_MARKS].map(char => hex(char.codePointAt(0))),
      letterEmoji: N.ASSISTANT_NAME_LETTER_EMOJI.map(range),
      everythingElse:
        'any other unit: other scripts and their digits, symbols, Cc/Cf/Zl/Zp/Co/Cn, an accent NFC leaves loose, a joiner, selector, tag or regional indicator outside an emoji'
    },
    needsLetterOrDigit: 'at least one unit in latin, han, kana, hangul or digits',
    mixedScripts: 'refused when kana and hangul are both present (UTS #39 highly restrictive over the allowed scripts)',
    skeleton: {
      of: 'a Latin text: Latin letters, ASCII digits and ? (a wildcard)',
      steps: ['NFD', 'remove \\p{M}', 'skeletonLetters', 'lowercase', 'foldMerges in order, each a replace-all'],
      skeletonLetters: Object.fromEntries(
        Object.entries(N.ASSISTANT_NAME_SKELETON_LETTERS).map(([from, to]) => [hex(from.codePointAt(0)), to])
      ),
      soundMerges: N.ASSISTANT_NAME_SOUND_MERGES,
      lookMerges: N.ASSISTANT_NAME_LOOK_MERGES,
      foldMerges: N.ASSISTANT_NAME_FOLD_MERGES
    },
    reserved: {
      readFlagsAs:
        'each flag (two regional indicators) is read as its two capital letters A-Z before every reserved-name check',
      exactNames: N.ASSISTANT_RESERVED_NAMES,
      exactKeys: N.ASSISTANT_RESERVED_NAMES.map(name => N.assistantNameKey(name)),
      exactRule: 'assistantNameKey(the whole name) is an exact key',
      wordNames: N.ASSISTANT_RESERVED_WORDS,
      wordKeys: N.ASSISTANT_RESERVED_WORDS.map(name => N.assistantNameKey(name)),
      wordRule: 'assistantNameKey of any word (split on spaces and punctuation) contains a word key',
      foldNames: N.ASSISTANT_FOLD_RESERVED_NAMES,
      foldSkeletons: skeletons(N.ASSISTANT_FOLD_RESERVED_NAMES),
      personNames: N.ASSISTANT_RESERVED_PERSON_NAMES,
      personSkeletons: skeletons(
        N.ASSISTANT_FOLD_RESERVED_NAMES.filter(name => N.ASSISTANT_RESERVED_PERSON_NAMES.includes(name))
      ),
      brandSkeletons: skeletons(
        N.ASSISTANT_FOLD_RESERVED_NAMES.filter(name => !N.ASSISTANT_RESERVED_PERSON_NAMES.includes(name))
      ),
      ben: 'assistantNameKey of a candidate with ? and * removed is "ben" (accents kept: "Bến" is not Ben)',
      prefix: N.ASSISTANT_RESERVED_PREFIX,
      suffix: N.ASSISTANT_RESERVED_SUFFIX.source,
      joinable: [
        ...new Set([
          ...skeletons(N.ASSISTANT_FOLD_RESERVED_NAMES),
          skeleton(N.ASSISTANT_RESERVED_PREFIX),
          skeleton('ben')
        ])
      ],
      roleWords: N.ASSISTANT_RESERVED_ROLE_WORDS,
      roleSkeletons: skeletons(N.ASSISTANT_RESERVED_ROLE_WORDS),
      roleAffixes: N.ASSISTANT_RESERVED_ROLE_AFFIXES,
      roleAffixSkeletons: skeletons(N.ASSISTANT_RESERVED_ROLE_AFFIXES),
      pairs: N.ASSISTANT_RESERVED_PAIRS,
      letterCase: {
        upper: caseRanges('upper').map(range),
        lower: caseRanges('lower').map(range)
      },
      candidates: [
        'name: the whole name: its Latin letters and digits, in order',
        'whole: each word (split on spaces and punctuation): a unit that is not a Latin letter or digit becomes * when both neighbours in the word are Latin letters or digits, ? when one is, else it is dropped; and that text again without a ? at its start, at its end, and at both',
        "masked: each word with two or more Latin letters or digits that starts with two or more other units: the word's marked text with each of those leading units as ?",
        "parts: each run of Latin letters and digits inside a word, and each part of such a run cut between a lower and an upper letter and before the last upper letter of an upper run followed by a lower letter (letterCase), and each part of it cut there and also between a letter and a digit; those that are not one of the same word's whole candidates",
        'each of these again without its leading and trailing digits (when that leaves something)'
      ],
      rule: [
        'refused when the name candidate is ben, spells a fold skeleton or starts with the prefix (? matching any one character, * any one or two)',
        'refused when a whole candidate spells a brand skeleton, starts with the prefix, matches suffix or is one of pairs; a whole candidate that is ben or spells a person skeleton makes its word a person word',
        'refused when a masked candidate spells a brand skeleton; one that spells a person skeleton makes its word a person word',
        'refused when a parts candidate is ben, spells a fold skeleton, starts with the prefix, matches suffix or is one of pairs',
        'otherwise accepted when no word is a person word',
        "with a person word, refused unless another word (not a person word) has two or more Latin letters (a flag's letters not counted), no whole or parts candidate's skeleton is a role skeleton or starts or ends (and is longer than) a role affix skeleton, and no two or more consecutive words between person words (their Latin letters and digits joined, words without any left out, also without leading and trailing digits) are ben or have a skeleton that is a role skeleton, a fold skeleton or one of pairs"
      ],
      primary:
        'the primary may use the whole key "atum", "atumbot" or one of Atum\'s CJK spelling keys; every other rule applies to it',
      person:
        'Moon, Ben, Andy and Taylor are people\'s names too: one may be a word of a person\'s longer name ("Andy Nguyễn", "Taylor Swift", "Moon Jae-in"), never the whole name, never joined to another word with no break, never next to a role word'
    },
    duplicates:
      'assistantNameKey equal to another live assistant of the same owner: units without spaces, punctuation and emoji, NFD, lowercase, only letters, digits and marks, lookMerges (not soundMerges), NFC; accents kept (owner decision D3)'
  }
}

/** The SQL functions (`create or replace`, idempotent) for the migration and the constraint. */
export function assistantNameSql(schema = 'atum_private') {
  const latin = `0-9A-Za-z${body(N.ASSISTANT_NAME_LETTERS.latin.filter(([low]) => low > 0x7f))}`
  const han = body(N.ASSISTANT_NAME_LETTERS.han)
  const kana = body(N.ASSISTANT_NAME_LETTERS.kana)
  const hangul = body(N.ASSISTANT_NAME_LETTERS.hangul)
  const marks = " '.&," // and '-', always last in a bracket so it is literal
  const tone = '[\\U0001F3FB-\\U0001F3FF]'
  const pict = `[${body(pictographs())}]`
  const byFirst = new Map()

  for (const letters of flagPairs()) {
    byFirst.set(letters[0], [...(byFirst.get(letters[0]) ?? []), letters[1]])
  }

  const regionalRanges = seconds => {
    const ranges = []

    for (const letter of seconds) {
      const codePoint = regional(letter).codePointAt(0)
      const last = ranges.at(-1)

      if (last && last[1] === codePoint - 1) {
        last[1] = codePoint
      } else {
        ranges.push([codePoint, codePoint])
      }
    }

    return body(ranges)
  }
  const flags = [...byFirst]
    .map(([first, seconds]) => `${are(regional(first).codePointAt(0))}[${regionalRanges(seconds)}]`)
    .join('|')
  const tagFlags = TAG_FLAGS.map(letters => [...tagFlag(letters)].map(char => are(char.codePointAt(0))).join('')).join(
    '|'
  )
  const emoji = `(?:${pict}[\\uFE0E\\uFE0F]?${tone}?(?:\\u200D${pict}[\\uFE0E\\uFE0F]?${tone}?)*|${flags}|${tagFlags}|${tone})`
  const upper = body(caseRanges('upper'))
  const lower = body(caseRanges('lower'))
  const latinLetters = `A-Za-z${body(N.ASSISTANT_NAME_LETTERS.latin.filter(([low]) => low > 0x7f))}`
  const regionals = Array.from({ length: 26 }, (_, index) => are(REGIONAL_A + index)).join('')
  const capitals = Array.from({ length: 26 }, (_, index) => String.fromCharCode(0x41 + index)).join('')
  // Primary-only exceptions. `assistantNameKey` makes Atum Bot, Atum-Bot and AtumBot equivalent.
  const primaryKeys = ['Atum', 'Atum Bot', ...N.ASSISTANT_RESERVED_CJK_ATUM].map(name => N.assistantNameKey(name))
  const nest = (expression, merges) =>
    merges.reduce((inner, [from, to]) => `replace(${inner}, ${quote(from)}, ${quote(to)})`, expression)
  const letters = Object.entries(N.ASSISTANT_NAME_SKELETON_LETTERS)
  const upperLetters = letters.map(([letter]) => letter).filter(letter => letter !== letter.toLowerCase())
  const list = values => `array[${values.map(quote).join(', ')}]`
  const fn = name => `${schema}.${name}`
  const personFolds = skeletons(
    N.ASSISTANT_FOLD_RESERVED_NAMES.filter(name => N.ASSISTANT_RESERVED_PERSON_NAMES.includes(name))
  )
  const brandFolds = skeletons(
    N.ASSISTANT_FOLD_RESERVED_NAMES.filter(name => !N.ASSISTANT_RESERVED_PERSON_NAMES.includes(name))
  )

  return `-- Assistant names, rule set v6 (Unicode ${process.versions.unicode}): generated by atum-app
-- apps/desktop/scripts/assistant-name-sql.mjs from apps/desktop/shared/matrix-assistant-name.ts.
-- Locale-independent: no [[:alnum:]], and lower() only after letters are ASCII.

-- Latin letters and ASCII digits: what a skeleton is made of.
create or replace function ${fn('assistant_name_latin')}() returns text
language sql immutable parallel safe as $f$ select ${quote(`[${latin}]`)}::text $f$;

-- One emoji: pictographs with a selector and skin tone joined by U+200D, a recommended (RGI)
-- flag, one of the three recommended tag flags, or a lone skin tone. Never a framed letter,
-- keycap or check mark. Any join of allowed pictographs passes, where the desktop takes only
-- recommended ones: such a join draws as pictographs, never as a letter.
create or replace function ${fn('assistant_name_emoji')}() returns text
language sql immutable parallel safe as $f$ select ${quote(emoji)}::text $f$;

-- What the desktop stores passes; anything else fails (refused, never repaired).
create or replace function ${fn('assistant_name_shape_ok')}(p text) returns boolean
language sql immutable strict parallel safe as $f$
  select p = normalize(p, NFC)
    and char_length(p) between 1 and ${N.ASSISTANT_NAME_MAX}
    and p !~ '^ | $|  '
    and p ~ ('^(?:' || ${fn('assistant_name_emoji')}() || ${quote(`|[${marks}${latin}${han}${kana}${hangul}-])+$`)})
    and p ~ ${quote(`[${latin}${han}${kana}${hangul}]`)}
    and not (p ~ ${quote(`[${kana}]`)} and p ~ ${quote(`[${hangul}]`)})
$f$;

-- assistantNameKey: duplicates and the exact reserved names (accents kept, look merges).
create or replace function ${fn('assistant_name_key')}(p text) returns text
language sql immutable strict parallel safe as $f$
  select normalize(${nest(
    `translate(lower(normalize(regexp_replace(regexp_replace(p, ${fn('assistant_name_emoji')}(), '', 'g'), ${quote(`[${marks}-]`)}, '', 'g'), NFD)), ${quote(upperLetters.join(''))}, ${quote(upperLetters.map(letter => letter.toLowerCase()).join(''))})`,
    N.ASSISTANT_NAME_LOOK_MERGES
  )}, NFC)
$f$;

-- A Latin text's skeleton: accents out, the letters that do not decompose spelled out,
-- lowercase, then the sound and look merges in order.
create or replace function ${fn('assistant_name_skeleton')}(p text) returns text
language sql immutable strict parallel safe as $f$
  select ${nest(
    `lower(${letters.reduce((inner, [from, to]) => `replace(${inner}, ${quote(from)}, ${quote(to)})`, `regexp_replace(normalize(p, NFD), '[\\u0300-\\u036F]', '', 'g')`)})`,
    N.ASSISTANT_NAME_FOLD_MERGES
  )}
$f$;

-- foldAssistantName: the whole name's Latin letters and digits through the skeleton.
create or replace function ${fn('fold_name')}(p text) returns text
language sql immutable strict parallel safe as $f$
  select ${fn('assistant_name_skeleton')}(regexp_replace(regexp_replace(p, ${fn('assistant_name_emoji')}(), '', 'g'), ${quote(`[^${latin}]`)}, '', 'g'))
$f$;

-- isReservedAssistantName (see the candidates and rules in the rule set). Flags are read as
-- their two capital letters first, as Windows draws them. Moon, Ben, Andy and Taylor may be a
-- word of a person's longer name ("Andy Nguyễn"), never the whole name or next to a role word.
create or replace function ${fn('assistant_name_reserved')}(p text, is_default boolean) returns boolean
language plpgsql immutable strict parallel safe as $f$
declare
  latin constant text := ${fn('assistant_name_latin')}();
  other constant text := ${quote(`[^${latin}${marks}-]`)};
  glued constant text := ${quote(`[^${latin}${marks}*?-]`)};
  separators constant text := ${quote(`[${marks}-]+`)};
  lettered constant text := translate(p, E${quote(regionals)}, ${quote(capitals)});
  key constant text := ${fn('assistant_name_key')}(lettered);
  folds constant text[] := ${list(skeletons(N.ASSISTANT_FOLD_RESERVED_NAMES))};
  person_folds constant text[] := ${list(personFolds)};
  brand_folds constant text[] := ${list(brandFolds)};
  roles constant text[] := ${list(skeletons(N.ASSISTANT_RESERVED_ROLE_WORDS))};
  affixes constant text[] := ${list(skeletons(N.ASSISTANT_RESERVED_ROLE_AFFIXES))};
  pairs constant text[] := ${list(N.ASSISTANT_RESERVED_PAIRS)};
  units constant text := regexp_replace(lettered, ${fn('assistant_name_emoji')}(), E'\\uE000', 'g');
  -- The words, from the units and (to count a person's letters, not a flag's) from p itself.
  unit_words constant text[] := array(select w from regexp_split_to_table(units, separators) as w where w <> '');
  plain_words constant text[] := array(select w from regexp_split_to_table(p, separators) as w where w <> '');
  latins text[] := array[]::text[];
  people boolean[] := array[]::boolean[];
  letters integer[] := array[]::integer[];
  whole text[];
  masked text[];
  inside text[];
  segment text[];
  person boolean;
  role boolean := false;
  word text;
  candidate text;
  bare text;
  skeleton text;
  fold text;
  joined text;
  run text[];
  marked text;
  cut text;
  size integer;
begin
  if is_default and key = any(${list(primaryKeys)}) then
    return false;
  end if;

  if key = any(${list(N.ASSISTANT_RESERVED_NAMES.map(name => N.assistantNameKey(name)))}) then
    return true;
  end if;

  for word in select part from regexp_split_to_table(lettered, separators) as part loop
    if exists (select 1 from unnest(${list(N.ASSISTANT_RESERVED_WORDS.map(name => N.assistantNameKey(name)))}) as reserved
      where strpos(${fn('assistant_name_key')}(word), reserved) > 0) then
      return true;
    end if;
  end loop;

  -- The whole name's Latin letters and digits read together ("M o o n", "Moon 小明").
  candidate := regexp_replace(units, ${quote(`[^${latin}]`)}, '', 'g');

  foreach bare in array array[candidate, regexp_replace(candidate, '^[0-9]+|[0-9]+$', '', 'g')] loop
    continue when bare = '';
    skeleton := ${fn('assistant_name_skeleton')}(bare);

    if ${fn('assistant_name_key')}(bare) = ${quote(N.assistantNameKey('ben'))} or skeleton = any(folds)
      or left(skeleton, ${N.ASSISTANT_RESERVED_PREFIX.length}) = ${quote(N.ASSISTANT_RESERVED_PREFIX)} then
      return true;
    end if;
  end loop;

  for at in 1 .. coalesce(array_length(unit_words, 1), 0) loop
    word := unit_words[at];
    person := false;
    latins := latins || regexp_replace(word, ${quote(`[^${latin}]`)}, '', 'g');
    letters := letters || char_length(regexp_replace(plain_words[at], ${quote(`[^${latinLetters}]`)}, '', 'g'));

    if word ~ latin then
      marked := regexp_replace(
        regexp_replace(
          regexp_replace(word, '(?<=' || latin || ')' || other || '(?=' || latin || ')', '*', 'g'),
          '(?<=' || latin || ')' || glued || '|' || glued || '(?=' || latin || ')', '?', 'g'
        ),
        ${quote(`[^${latin}?*]`)}, '', 'g'
      );
      whole := array[]::text[];

      -- A character at either end may be a letter or a decoration: "丅aylor🌙" is Taylor.
      foreach candidate in array array[marked, regexp_replace(marked, '^\\?', ''), regexp_replace(marked, '\\?$', ''),
        regexp_replace(marked, '^\\?|\\?$', '', 'g')] loop
        bare := regexp_replace(candidate, '^[0-9]+|[0-9]+$', '', 'g');
        whole := whole || candidate;

        if bare <> '' and bare <> candidate then
          whole := whole || bare;
        end if;
      end loop;

      -- Two or more other characters before the first Latin letter: each one letter ("ハ丁UM").
      masked := array[]::text[];
      size := char_length(substring(word from ${quote(`^[^${latin}]*`)}));

      if size >= 2 and char_length(regexp_replace(word, ${quote(`[^${latin}]`)}, '', 'g')) >= 2 then
        candidate := repeat('?', size) || substr(marked, 2);
        masked := array[candidate, regexp_replace(candidate, '^[0-9]+|[0-9]+$', '', 'g')];
      end if;

      -- Runs of Latin letters and digits, cut where a reader sees a break; not a whole reading.
      inside := array[]::text[];

      for run in select regexp_matches(word, '(' || latin || '+)', 'g') loop
        cut := regexp_replace(regexp_replace(run[1],
          ${quote(`([${lower}])(?=[${upper}])`)}, '\\1 ', 'g'),
          ${quote(`([${upper}])(?=[${upper}][${lower}])`)}, '\\1 ', 'g');

        foreach candidate in array array[run[1]] || regexp_split_to_array(cut, ' ') || regexp_split_to_array(
          regexp_replace(regexp_replace(cut,
            ${quote(`([0-9])(?=[${latinLetters}])`)}, '\\1 ', 'g'),
            ${quote(`([${latinLetters}])(?=[0-9])`)}, '\\1 ', 'g'),
          ' '
        ) loop
          foreach bare in array array[candidate, regexp_replace(candidate, '^[0-9]+|[0-9]+$', '', 'g')] loop
            continue when bare = '' or bare = any(whole);
            inside := inside || bare;
          end loop;
        end loop;
      end loop;

      foreach candidate in array whole loop
        skeleton := ${fn('assistant_name_skeleton')}(candidate);

        if skeleton ~ ${quote(N.ASSISTANT_RESERVED_SUFFIX.source)} or skeleton = any(pairs) then
          return true;
        end if;

        -- Without a wildcard, plain comparisons (a regular expression per candidate is the slow part).
        if strpos(skeleton, '?') = 0 and strpos(skeleton, '*') = 0 then
          if skeleton = any(brand_folds) or left(skeleton, ${N.ASSISTANT_RESERVED_PREFIX.length}) = ${quote(N.ASSISTANT_RESERVED_PREFIX)} then
            return true;
          end if;

          person := person or skeleton = any(person_folds);
        else
          foreach fold in array brand_folds loop
            if fold ~ ('^' || replace(replace(skeleton, '?', '.'), '*', '.{1,2}') || '$') then
              return true;
            end if;
          end loop;

          for size in 1 .. least(${N.ASSISTANT_RESERVED_PREFIX.length}, char_length(skeleton)) loop
            if ${quote(N.ASSISTANT_RESERVED_PREFIX)} ~ ('^' || replace(replace(left(skeleton, size), '?', '.'), '*', '.{1,2}') || '$') then
              return true;
            end if;
          end loop;

          foreach fold in array person_folds loop
            person := person or fold ~ ('^' || replace(replace(skeleton, '?', '.'), '*', '.{1,2}') || '$');
          end loop;
        end if;

        person := person or ${fn('assistant_name_key')}(translate(candidate, '?*', '')) = ${quote(N.assistantNameKey('ben'))};
        role := role or skeleton = any(roles) or exists (select 1 from unnest(affixes) as affix
          where char_length(skeleton) > char_length(affix) and (left(skeleton, char_length(affix)) = affix
            or right(skeleton, char_length(affix)) = affix));
      end loop;

      -- Masked words: compared whole against Atum's names, nothing else.
      foreach candidate in array masked loop
        continue when candidate = '';
        skeleton := ${fn('assistant_name_skeleton')}(candidate);

        foreach fold in array brand_folds loop
          if fold ~ ('^' || replace(replace(skeleton, '?', '.'), '*', '.{1,2}') || '$') then
            return true;
          end if;
        end loop;

        foreach fold in array person_folds loop
          person := person or fold ~ ('^' || replace(replace(skeleton, '?', '.'), '*', '.{1,2}') || '$');
        end loop;
      end loop;

      -- One of Atum's names joined to something inside the word.
      foreach candidate in array inside loop
        skeleton := ${fn('assistant_name_skeleton')}(candidate);

        if ${fn('assistant_name_key')}(candidate) = ${quote(N.assistantNameKey('ben'))} or skeleton = any(folds)
          or left(skeleton, ${N.ASSISTANT_RESERVED_PREFIX.length}) = ${quote(N.ASSISTANT_RESERVED_PREFIX)}
          or skeleton ~ ${quote(N.ASSISTANT_RESERVED_SUFFIX.source)} or skeleton = any(pairs) then
          return true;
        end if;

        role := role or skeleton = any(roles) or exists (select 1 from unnest(affixes) as affix
          where char_length(skeleton) > char_length(affix) and (left(skeleton, char_length(affix)) = affix
            or right(skeleton, char_length(affix)) = affix));
      end loop;
    end if;

    people := people || person;
  end loop;

  if not (true = any(people)) then
    return false;
  end if;

  -- A person's name with one of Atum's in it: another word of it with two or more letters,
  -- not one of Atum's, and no role word anywhere.
  if role or not exists (select 1 from generate_subscripts(people, 1) as i where not people[i] and letters[i] >= 2) then
    return true;
  end if;

  -- Words read together between Atum's names: a role word, one of Atum's names or a pair.
  segment := array[]::text[];

  for at in 1 .. array_length(people, 1) + 1 loop
    if at <= array_length(people, 1) and not people[at] then
      if latins[at] <> '' then
        segment := segment || latins[at];
      end if;

      continue;
    end if;

    for head in 1 .. coalesce(array_length(segment, 1), 0) loop
      joined := segment[head];

      for tail in head + 1 .. array_length(segment, 1) loop
        joined := joined || segment[tail];

        foreach bare in array array[joined, regexp_replace(joined, '^[0-9]+|[0-9]+$', '', 'g')] loop
          continue when bare = '';
          skeleton := ${fn('assistant_name_skeleton')}(bare);

          if ${fn('assistant_name_key')}(bare) = ${quote(N.assistantNameKey('ben'))} or skeleton = any(roles)
            or skeleton = any(folds) or skeleton = any(pairs) then
            return true;
          end if;
        end loop;
      end loop;
    end loop;

    segment := array[]::text[];
  end loop;

  return false;
end
$f$;
`
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const schemaAt = process.argv.indexOf('--schema')

  process.stdout.write(
    process.argv.includes('--json')
      ? `${JSON.stringify(assistantNameRules(), null, 2)}\n`
      : assistantNameSql(schemaAt > 0 ? process.argv[schemaAt + 1] : undefined)
  )
}
