// Country name mapping and extraction
export const COUNTRY_MAPPING: Record<string, string> = {
  "united states": "US", "usa": "US", "u.s.": "US", "america": "US",
  "china": "CN", "chinese": "CN", "beijing": "CN",
  "japan": "JP", "japanese": "JP", "tokyo": "JP",
  "germany": "DE", "german": "DE", "berlin": "DE",
  "france": "FR", "french": "FR", "paris": "FR",
  "united kingdom": "GB", "uk": "GB", "britain": "GB", "british": "GB", "london": "GB",
  "italy": "IT", "italian": "IT", "rome": "IT",
  "spain": "ES", "spanish": "ES", "madrid": "ES",
  "canada": "CA", "canadian": "CA",
  "india": "IN", "indian": "IN", "delhi": "IN", "mumbai": "IN",
  "brazil": "BR", "brazilian": "BR",
  "russia": "RU", "russian": "RU", "moscow": "RU",
  "south korea": "KR", "korea": "KR", "korean": "KR", "seoul": "KR",
  "australia": "AU", "australian": "AU",
  "mexico": "MX", "mexican": "MX",
  "indonesia": "ID", "indonesian": "ID",
  "netherlands": "NL", "dutch": "NL", "amsterdam": "NL",
  "saudi arabia": "SA", "saudi": "SA", "riyadh": "SA",
  "turkey": "TR", "turkish": "TR", "ankara": "TR",
  "switzerland": "CH", "swiss": "CH",
  "poland": "PL", "polish": "PL", "warsaw": "PL",
  "belgium": "BE", "belgian": "BE", "brussels": "BE",
  "sweden": "SE", "swedish": "SE", "stockholm": "SE",
  "iran": "IR", "iranian": "IR", "tehran": "IR",
  "thailand": "TH", "thai": "TH", "bangkok": "TH",
  "nigeria": "NG", "nigerian": "NG",
  "argentina": "AR", "argentinian": "AR", "buenos aires": "AR",
  "norway": "NO", "norwegian": "NO", "oslo": "NO",
  "austria": "AT", "austrian": "AT", "vienna": "AT",
  "uae": "AE", "emirates": "AE", "dubai": "AE", "abu dhabi": "AE",
  "israel": "IL", "israeli": "IL", "tel aviv": "IL",
  "singapore": "SG", "singaporean": "SG",
  "hong kong": "HK",
  "malaysia": "MY", "malaysian": "MY",
  "south africa": "ZA", "african": "ZA",
  "egypt": "EG", "egyptian": "EG", "cairo": "EG",
  "vietnam": "VN", "vietnamese": "VN",
  "philippines": "PH", "philippine": "PH", "manila": "PH",
  "pakistan": "PK", "pakistani": "PK",
  "bangladesh": "BD",
  "colombia": "CO", "colombian": "CO",
  "chile": "CL", "chilean": "CL",
  "finland": "FI", "finnish": "FI",
  "denmark": "DK", "danish": "DK",
  "greece": "GR", "greek": "GR", "athens": "GR",
  "portugal": "PT", "portuguese": "PT",
  "czech": "CZ", "prague": "CZ",
  "romania": "RO", "romanian": "RO",
  "new zealand": "NZ",
  "iraq": "IQ", "iraqi": "IQ",
  "qatar": "QA",
  "kuwait": "KW",
  "ukraine": "UA", "ukrainian": "UA", "kyiv": "UA",
  "venezuela": "VE", "venezuelan": "VE"
};

export function extractCountries(text: string): string[] {
  const lowerText = text.toLowerCase();
  const found = new Set<string>();

  for (const [keyword, code] of Object.entries(COUNTRY_MAPPING)) {
    if (lowerText.includes(keyword)) {
      found.add(code);
    }
  }

  return Array.from(found);
}
