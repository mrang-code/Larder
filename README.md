# Larder

A kitchen tracker that runs as a home-screen app on iPhone.

- **Kitchen** – add a shop in one go (type it, scan barcodes, paste an order, or photograph the receipt). Expiry dates fill themselves in. Swipe to mark things used up or binned, with undo.
- **Spices** – rough levels; low ones go onto the shopping list.
- **Recipes** – ranked by what you have and what expires first, filtered by diet and the appliances you own. Realistic portions for the number of people you cook for. Favourites and "not for me" shape what you're shown. Import your own from a link, text or photo.
- **Plan** – a week of meals checked against what will still be fresh, with one combined shopping list.
- **List** – fills itself from expired food, used-up items, low spices and recipe gaps.
- **Amounts** – recipes take what they use from your kitchen (500g chicken minus 300g leaves 200g), scaled to the servings you pick.
- **Cook mode** – one step at a time with timers.
- **Shared kitchen** – one kitchen, list and plan across several phones.
- **Waste tracker** – food used up vs binned each month.
- **Food diary** – what you cooked and ate each day, with your portion, ready to copy into Google Health Coach; optional end-of-day reminder.
- **Reminders** – optional notifications on days something needs using up (`server/worker.js`, a free Cloudflare Worker that also runs the shared kitchen).

Live at https://mrang-code.github.io/Larder/

Everything is stored on the phone. The AI features use your own free Gemini API key, entered in Preferences.
