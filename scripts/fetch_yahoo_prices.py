import datetime
import json
import sys
import urllib.parse
import urllib.request


def fetch_monthly_prices(ticker):
    period1 = int(datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc).timestamp())
    period2 = int((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).timestamp())
    query = urllib.parse.urlencode(
        {
            "period1": period1,
            "period2": period2,
            "interval": "1mo",
            "events": "history",
            "includeAdjustedClose": "true",
        }
    )
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{ticker}?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )

    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.load(response)

    result = payload.get("chart", {}).get("result", [None])[0]
    error = payload.get("chart", {}).get("error")
    if error:
        raise RuntimeError(f"{ticker} 行情获取失败：{error.get('description') or error.get('code')}")
    if not result or not result.get("timestamp"):
        raise RuntimeError(f"{ticker} 没有返回月度价格")

    quote = result.get("indicators", {}).get("quote", [{}])[0]
    adjusted = result.get("indicators", {}).get("adjclose", [{}])[0].get("adjclose", [])
    month_to_close = {}

    for index, timestamp in enumerate(result["timestamp"]):
        close = adjusted[index] if index < len(adjusted) and adjusted[index] is not None else quote.get("close", [None])[index]
        if close is None:
            continue

        date = datetime.datetime.fromtimestamp(timestamp, tz=datetime.timezone.utc)
        month = f"{date.year:04d}-{date.month:02d}"
        month_to_close[month] = round(float(close), 6)

    return [
        {
            "date": f"{month}-01",
            "close": month_to_close[month],
        }
        for month in sorted(month_to_close)
    ]


def main():
    tickers = sys.argv[1:]
    if not tickers:
        raise SystemExit("Usage: fetch_yahoo_prices.py TICKER [TICKER...]")

    result = {ticker: fetch_monthly_prices(ticker) for ticker in tickers}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
