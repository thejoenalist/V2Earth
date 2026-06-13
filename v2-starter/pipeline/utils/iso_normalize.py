"""
iso_normalize.py — Python mirror of ISONormalizer.js.

Used by pipeline scripts to ensure all baked data uses consistent ISO alpha-3 codes.
"""

# Alpha-2 → Alpha-3 (abbreviated — add more as needed)
_LOOKUP = {
    "AF":"AFG","AL":"ALB","DZ":"DZA","AR":"ARG","AM":"ARM","AU":"AUS","AT":"AUT",
    "AZ":"AZE","BS":"BHS","BH":"BHR","BD":"BGD","BY":"BLR","BE":"BEL","BZ":"BLZ",
    "BJ":"BEN","BT":"BTN","BO":"BOL","BA":"BIH","BW":"BWA","BR":"BRA","BN":"BRN",
    "BG":"BGR","BF":"BFA","BI":"BDI","KH":"KHM","CM":"CMR","CA":"CAN","CF":"CAF",
    "TD":"TCD","CL":"CHL","CN":"CHN","CO":"COL","CG":"COG","CD":"COD","CR":"CRI",
    "CI":"CIV","HR":"HRV","CU":"CUB","CY":"CYP","CZ":"CZE","DK":"DNK","DJ":"DJI",
    "DO":"DOM","EC":"ECU","EG":"EGY","SV":"SLV","GQ":"GNQ","ER":"ERI","EE":"EST",
    "ET":"ETH","FJ":"FJI","FI":"FIN","FR":"FRA","GA":"GAB","GM":"GMB","GE":"GEO",
    "DE":"DEU","GH":"GHA","GR":"GRC","GT":"GTM","GN":"GIN","GW":"GNB","GY":"GUY",
    "HT":"HTI","HN":"HND","HK":"HKG","HU":"HUN","IS":"ISL","IN":"IND","ID":"IDN",
    "IR":"IRN","IQ":"IRQ","IE":"IRL","IL":"ISR","IT":"ITA","JM":"JAM","JP":"JPN",
    "JO":"JOR","KZ":"KAZ","KE":"KEN","KP":"PRK","KR":"KOR","KW":"KWT","KG":"KGZ",
    "LA":"LAO","LV":"LVA","LB":"LBN","LS":"LSO","LR":"LBR","LY":"LBY","LT":"LTU",
    "LU":"LUX","MG":"MDG","MW":"MWI","MY":"MYS","MV":"MDV","ML":"MLI","MT":"MLT",
    "MR":"MRT","MU":"MUS","MX":"MEX","MD":"MDA","MN":"MNG","ME":"MNE","MA":"MAR",
    "MZ":"MOZ","MM":"MMR","NA":"NAM","NP":"NPL","NL":"NLD","NZ":"NZL","NI":"NIC",
    "NE":"NER","NG":"NGA","NO":"NOR","OM":"OMN","PK":"PAK","PS":"PSE","PA":"PAN",
    "PG":"PNG","PY":"PRY","PE":"PER","PH":"PHL","PL":"POL","PT":"PRT","QA":"QAT",
    "RO":"ROU","RU":"RUS","RW":"RWA","SA":"SAU","SN":"SEN","RS":"SRB","SL":"SLE",
    "SG":"SGP","SK":"SVK","SI":"SVN","SB":"SLB","SO":"SOM","ZA":"ZAF","SS":"SSD",
    "ES":"ESP","LK":"LKA","SD":"SDN","SR":"SUR","SE":"SWE","CH":"CHE","SY":"SYR",
    "TW":"TWN","TJ":"TJK","TZ":"TZA","TH":"THA","TL":"TLS","TG":"TGO","TO":"TON",
    "TT":"TTO","TN":"TUN","TR":"TUR","TM":"TKM","UG":"UGA","UA":"UKR","AE":"ARE",
    "GB":"GBR","US":"USA","UY":"URY","UZ":"UZB","VU":"VUT","VE":"VEN","VN":"VNM",
    "YE":"YEM","ZM":"ZMB","ZW":"ZWE",
    # Aliases
    "UK":"GBR","ENGLAND":"GBR","BRITAIN":"GBR","RUSSIA":"RUS","CHINA":"CHN",
    "IRAN":"IRN","TAIWAN":"TWN","VIETNAM":"VNM","MYANMAR":"MMR","BURMA":"MMR",
    "CZECHIA":"CZE","TURKEY":"TUR",
}

_ALPHA3 = set(_LOOKUP.values())

def normalize_iso(value: str) -> str | None:
    """Normalize any country identifier to ISO 3166-1 alpha-3, or return None."""
    if not value:
        return None
    clean = str(value).strip().upper()
    if clean in _ALPHA3:
        return clean
    return _LOOKUP.get(clean)
