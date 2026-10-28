import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from engine.scraper import scrape_url, is_available

def test_is_available_returns_bool():
    assert isinstance(is_available(), bool)

def test_scrape_url_returns_string_or_none():
    if not is_available():
        return
    result = scrape_url('https://example.com')
    assert result is None or isinstance(result, str)

class _FakeResp:
    encoding = 'utf-8'
    def __init__(self, chunks):
        self._chunks = chunks
    def raise_for_status(self):
        pass
    def iter_content(self, chunk_size=None):
        return iter(self._chunks)

def test_scrape_url_rejects_non_http_schemes():
    assert scrape_url('file:///etc/passwd') is None

def test_scrape_url_stops_on_oversized_response(monkeypatch):
    if not is_available():
        return
    import requests
    from engine import scraper
    big = [b'<p>' + b'a' * 65536 + b'</p>'] * ((scraper.MAX_BYTES // 65536) + 2)
    monkeypatch.setattr(requests, 'get', lambda *a, **k: _FakeResp(big))
    assert scrape_url('https://example.com') is None

def test_scrape_url_extracts_small_response(monkeypatch):
    if not is_available():
        return
    import requests
    html = b'<html><body><article><p>' + b'word ' * 50 + b'</p></article></body></html>'
    monkeypatch.setattr(requests, 'get', lambda *a, **k: _FakeResp([html]))
    assert 'word' in scrape_url('https://example.com')
