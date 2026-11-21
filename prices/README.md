# Weekly prices

`prices.json` (in the site root) is what every phone downloads. It is rebuilt every Monday by a scheduled Claude task:

1. Read `basket.json`. For each item and each store in `stores_direct`, open the store's own search page and note the price of the pack described in `want`.
2. Write `raw/<store>.json`: `{"<key>": {"price": 1.75, "loyalty": 1.60, "product": "exact name and size"}}` (prices in pounds; `loyalty` null when there isn't one).
3. Write `raw/which.json` from Which?'s latest "cheapest supermarket" monthly basket table (average basket price per store).
4. Run `python3 prices/build.py`, then commit `prices.json` and `prices/raw/`.

Shop pages used: Tesco `https://www.tesco.com/groceries/en-GB/search?query=Q`, Sainsbury's `https://www.sainsburys.co.uk/gol-ui/SearchResults/Q`, Morrisons `https://groceries.morrisons.com/search?q=Q`.
Asda, Aldi, Lidl, Ocado and Waitrose block automated reading, so their prices are scaled from the direct ones using the Which? factors.
