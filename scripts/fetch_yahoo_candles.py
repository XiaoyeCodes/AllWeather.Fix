import datetime
import json
import sys
import urllib.parse
import urllib.request


def fetch_daily_candles(ticker):
    period1 = int(datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc).timestamp())
    period2 = int((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).timestamp())
    query = urllib.parse.urlencode(
        {
            "period1": period1,
            "period2": period2,
            "interval": "1d",
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

    with urllib.request.urlopen(request, timeout=25) as response:
        payload = json.load(response)

    result = payload.get("chart", {}).get("result", [None])[0]
    error = payload.get("chart", {}).get("error")
    if error:
        raise RuntimeError(f"{ticker} 行情获取失败：{error.get('description') or error.get('code')}")
    if not result or not result.get("timestamp"):
        raise RuntimeError(f"{ticker} 没有返回日线价格")

    quote = result.get("indicators", {}).get("quote", [{}])[0]
    adjusted = result.get("indicators", {}).get("adjclose", [{}])[0].get("adjclose", [])
    candles = []

    for index, timestamp in enumerate(result["timestamp"]):
        open_price = quote.get("open", [None])[index]
        high = quote.get("high", [None])[index]
        low = quote.get("low", [None])[index]
        close = quote.get("close", [None])[index]
        volume = quote.get("volume", [None])[index]
        adj_close = adjusted[index] if index < len(adjusted) else None
        if None in (open_price, high, low, close):
            continue

        date = datetime.datetime.fromtimestamp(timestamp, tz=datetime.timezone.utc)
        candles.append(
            {
                "date": f"{date.year:04d}-{date.month:02d}-{date.day:02d}",
                "open": round(float(open_price), 4),
                "high": round(float(high), 4),
                "low": round(float(low), 4),
                "close": round(float(close), 4),
                "adjClose": round(float(adj_close), 4) if adj_close is not None else None,
                "volume": int(volume or 0),
            }
        )

    print(json.dumps({"ticker": ticker, "candles": candles}, ensure_ascii=False))


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: fetch_yahoo_candles.py TICKER")
    fetch_daily_candles(sys.argv[1])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
