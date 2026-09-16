# The car list as a Flow

`cars.json` is the Flow definition behind the tappable car list with
photographs. It is checked in rather than kept in Meta's builder because it is
part of the product: what a customer sees when they ask what is available.

## Why this exists

An interactive list row carries an id, a 24-character title and a 72-character
description, and nothing else. The header is text only. There is no picture
anywhere on that message and there is no version of it that has one. A commerce
catalog would give thumbnails, and forces a price, a stock flag and a condition
of `new`, `refurbished` or `used` onto every car — none of which this operator
has said, and two of which they deliberately have not.

A Flow is the remaining option.

## Publishing it

Needs the WhatsApp Business Account id, which is not derivable from the phone
number id with the token this project holds — `me/businesses` comes back empty
for a system user. It is in WhatsApp Manager, under the account's settings.

    curl -X POST "https://graph.facebook.com/v26.0/<WABA_ID>/flows" \
      -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" \
      -F "name=Cars" -F "categories=[\"OTHER\"]"

    curl -X POST "https://graph.facebook.com/v26.0/<FLOW_ID>/assets" \
      -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" \
      -F "asset_type=FLOW_JSON" -F "name=flow.json" \
      -F "file=@app/contracts/flows/cars.json;type=application/json"

    curl -X POST "https://graph.facebook.com/v26.0/<FLOW_ID>/publish" \
      -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"

Then set `WHATSAPP_FLOW_ID` on the worker. Until that variable is set nothing
changes: the agent sends the list message it sends today.

## What the validator settled

Meta's own component reference does not document NavigationList, and the
third-party specification that does contradicts itself about whether the
component may share a screen. Uploading the JSON answered both in two minutes,
which is worth remembering the next time a question like this eats an
afternoon:

- A screen carrying a NavigationList **cannot be terminal**. `"terminal": true`
  on it is rejected as `INVALID_PROPERTY_KEY`.
- A Flow **must** have a terminal screen somewhere, or `MISSING_TERMINAL_SCREEN`.
- So there are two screens. CARS holds the list; DONE exists to be the terminal
  one. Items complete the Flow directly from CARS, which the validator accepts
  — whether it works at runtime is the one thing left for a phone to answer.
- The heading and footer the third-party example showed beside a NavigationList
  were never tried, because the component needs no company.

## Publishing is blocked, and not by us

    "error_user_title": "Flow publishing failed"
    "error_user_msg": "Integrity requirements not met."

Meta will not publish a Flow for a business that has not completed verification
— the first unticked step in the build plan. The Flow exists as a DRAFT with no
validation errors and stays there until that clears.

A draft can still be opened by anybody with a role on the business account, so
it can be tested now: send it with `draft: true`, which adds `mode: "draft"` to
the parameters and shows the tester a warning banner.

Flow id: `1913050626319671`. WABA: `1053819110616183`.

## What is not yet known

Meta's own component reference does not document `NavigationList`. The
third-party specification that does contradicts itself about whether it may
share a screen with other components, and claims it cannot sit on a terminal
screen — which, if true, means tapping a car cannot complete the Flow directly
and this needs a second screen with a confirm button.

That is a question a real phone answers in one minute and documentation has not
answered in an afternoon. It is the same shape as the album threshold, which
was wrong twice from the documentation and right the first time it was tested.
