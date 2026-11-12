/** Превращает stderr yt-dlp в понятное сообщение. */
const RULES = [
  ['drm', /drm|widevine|protected by.*(copyright|encryption)|this video is drm|fairplay/i, 'Видео защищено от копирования (DRM) — скачать его нельзя.'],
  ['space', /no space left|not enough (free )?space|file is larger than max-filesize|max[- ]filesize|disk full|ENOSPC/i, 'Не хватает места на диске (или файл больше лимита).'],
  ['rate', /http error 429|too many requests|rate[- ]limit/i, 'Сайт ограничил частоту запросов. Попробуй позже.'],
  ['bot', /confirm you.?re not a bot|sign in to confirm|not a bot/i, 'Сайт просит подтвердить, что ты не бот. Владельцу нужно загрузить cookies.txt в настройках.'],
  ['login', /login required|log in|sign in|please login|authentication required|requires authentication|cookies? (are|is) (needed|required)|use --cookies|rate-limit reached or login required|private account|this account is private|empty media response|need to log in|not logged in/i, 'Нужен вход в аккаунт (или аккаунт приватный). Владелец может загрузить cookies.txt в настройках.'],
  ['age', /age[- ]restrict|confirm your age|inappropriate for some users|age.?gate|over 18/i, 'Возрастное ограничение: нужен вход в аккаунт — загрузи cookies.txt в настройках.'],
  ['geo', /not available in your country|geo[- ]?restrict|blocked it in your country|this video is not available from your location|available in your country/i, 'Видео недоступно в твоей стране (ограничение по региону). Можно попробовать прокси в настройках.'],
  ['private', /private video|video is private|this video is only available for registered|members[- ]only|join this channel/i, 'Видео приватное или только для подписчиков.'],
  ['gone', /video (has been )?(removed|deleted|unavailable)|this video is unavailable|no longer available|does not exist|video unavailable|has been terminated|content is not available|404|not found|page not found|not exist|account associated with this video has been terminated/i, 'Видео удалено, скрыто или такой страницы нет.'],
  ['forbidden', /http error 403|forbidden/i, 'Сайт отказал в доступе (403). Попробуем другие способы; если не выйдет — нужны cookies.'],
  ['unsupported', /unsupported url|no suitable extractor|is not a valid url|unable to find (any )?(video|media)|no video formats found|no (video|media) (could be )?found|there is no video in this post|no video could be found/i, 'Сайт не поддерживается или на странице нет видео.'],
  ['live', /this live event will begin|premieres in|live stream recording is not available|is upcoming/i, 'Это трансляция или премьера, которая ещё не началась или не записана.'],
  ['format', /requested format is not available|no video formats|only images are available/i, 'Запрошенное качество недоступно для этого видео.'],
  ['timeout', /timed out|timeout|connection reset|connection aborted|temporary failure|remote end closed|unable to download webpage.*(getaddrinfo|network)/i, 'Сайт долго не отвечает. Проверь интернет и попробуй ещё раз.'],
  ['network', /getaddrinfo|name or service not known|network is unreachable|certificate verify failed|ssl/i, 'Нет связи с сайтом (сеть, DNS или сертификат).'],
  ['parse', /unable to extract|extractorerror|unable to download (webpage|json)|json|signature extraction|nsig|player response|please report this issue|parsing|unexpected response/i, 'Не получилось разобрать страницу сайта. Возможно, сайт изменился — попробуй обновить yt-dlp в настройках.'],
];

export function classifyError(stderr) {
  const text = String(stderr || '');
  for (const [code, re, message] of RULES) if (re.test(text)) return { code, message };
  const last = text.trim().split(/\r?\n/).filter((l) => /error/i.test(l)).pop();
  return { code: 'unknown', message: 'Не удалось скачать.' + (last ? ` (${last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').slice(0, 160)})` : ' Подробности по кнопке.') };
}

/** Ошибки, при которых имеет смысл обновить yt-dlp. */
export const isParseError = (stderr) => /unable to extract|extractorerror|nsig|signature extraction|player response|unable to download (webpage|json)|please report this issue|unexpected response|no video formats found/i.test(stderr || '');
export const isYoutubeBlock = (stderr) => /http error 403|sign in to confirm|not a bot|requested format is not available|po token|forbidden|login required/i.test(stderr || '');

export const DRM_HOSTS = /(^|\.)(spotify\.com|netflix\.com|music\.apple\.com|tv\.apple\.com|primevideo\.com|disneyplus\.com|hbomax\.com|max\.com|hulu\.com|tidal\.com|deezer\.com|play\.google\.com|paramountplus\.com|peacocktv\.com|crunchyroll\.com|kinopoisk\.ru|ivi\.ru|okko\.tv|wink\.ru|more\.tv)$/i;
