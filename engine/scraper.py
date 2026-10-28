"""Optional URL text scraper. Gracefully degrades if requests/bs4 missing."""

MAX_BYTES = 2 * 1024 * 1024  # stop reading huge or endless responses

def is_available() -> bool:
    try:
        import requests
        from bs4 import BeautifulSoup
        return True
    except ImportError:
        return False

def scrape_url(url: str) -> str | None:
    if not is_available():
        return None
    import requests
    from bs4 import BeautifulSoup
    try:
        if not url.lower().startswith(('http://', 'https://')):
            return None
        resp = requests.get(url, timeout=10, stream=True, headers={
            'User-Agent': 'Mozilla/5.0 (Humanize-Kit Voice Analyzer)'
        })
        resp.raise_for_status()
        body = b''
        for chunk in resp.iter_content(chunk_size=65536):
            body += chunk
            if len(body) > MAX_BYTES:
                return None
        html = body.decode(resp.encoding or 'utf-8', errors='replace')
    except Exception:
        return None
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(['script', 'style', 'nav', 'header', 'footer', 'aside']):
        tag.decompose()
    for selector in ['article', 'main', '[role="main"]', 'body']:
        container = soup.select_one(selector)
        if container:
            paragraphs = container.find_all('p')
            if paragraphs:
                text = '\n\n'.join(p.get_text(strip=True) for p in paragraphs)
                if len(text) > 100:
                    return text
    return None
