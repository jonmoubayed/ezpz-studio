"""Authored Notice regression cases. Not real agreements or independent gold."""
from pathlib import Path


def fixtures(output, keys):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    scenarios = [
        ("annual-saas", "HarborDesk", "SaaS subscription", {}),
        ("business-day-notice", "RelayHost", "Managed hosting", {"noticeUnit": "business days", "noticePeriod": "10", "conditions": "Exclude Saturdays, Sundays, and US federal holidays."}),
        ("receipt-cutoff", "CedarSupport", "Support and maintenance", {"noticePeriod": "60", "conditions": "Notice must be received by 17:00 America/New_York on the notice deadline."}),
        ("monthly-service", "JuniperOps", "Outsourced operations service", {"months": "1", "amount": "900", "billing": "monthly", "noticePeriod": "15", "seats": None}),
        ("renewal-uplift", "AtlasMetrics", "Analytics subscription", {"amount": "12600", "uplift": "5% increase at renewal."}),
        ("per-seat-without-total", "WillowCloud", "Software subscription", {"amount": None, "seats": "25"}),
        ("manual-renewal", "NorthstarLicense", "Software license", {"autoRenew": "no", "renewalDate": None, "noticePeriod": None, "noticeUnit": None, "method": None, "recipient": None, "conditions": None}),
        ("amended-notice", "BirchBackup", "Backup subscription", {"noticePeriod": "60"}),
        ("conflicting-notice", "MapleSecurity", "Security monitoring", {"noticePeriod": "conflict"}),
        ("missing-notice-destination", "PineWorks", "Agency retainer", {"recipient": None, "seats": None, "timezone": None}),
    ]
    result = []
    for name, vendor, kind, changes in scenarios:
        values = dict(vendor=vendor, startDate="2026-01-01", endDate="2026-12-31", renewalDate="2027-01-01",
                      autoRenew="yes", noticePeriod="30", noticeUnit="calendar days", timezone="America/New_York",
                      amount="12000", currency="USD", billing="annually", months="12", seats="20", uplift="none",
                      method="email", recipient="renewals@" + vendor.lower() + ".example", conditions="none")
        values.update(changes)
        if name == "monthly-service":
            values.update(endDate="2026-01-31", renewalDate="2026-02-01")
        sections = ["FICTIONAL TEST CONTRACT — NOTICE REGRESSION FIXTURE", "This authored document is solely for software testing; it records no actual agreement.",
                    kind + " agreement", "1. Parties", vendor + " is the supplier. Acme Studio is the customer.",
                    "2. Service term", "The stated service term begins " + values["startDate"] + " and ends " + values["endDate"] + "."]
        if values["autoRenew"] == "yes":
            sections.append("The service renews automatically on " + values["renewalDate"] + " for successive " + values["months"] + " month terms.")
        else:
            sections.append("The stated service term lasts 12 months. There is no automatic renewal. Any further service requires a new signed order. No renewal date or non-renewal notice procedure is specified.")
        sections += ["3. Fees"]
        if values["amount"] is not None:
            sections.append("The explicitly agreed total commitment for the next term is USD " + values["amount"] + ", billed " + values["billing"] + ".")
        else:
            sections.append("The price is USD 40 per committed seat per month, billed annually. The order states no total next-term commitment; it contains only this per-seat rate.")
        if values["seats"] is not None:
            sections.append("There are " + values["seats"] + " committed seats.")
        if values["uplift"] == "none":
            sections.append("No renewal price change or uplift applies.")
        else:
            sections.append("The renewal price adjustment is: " + values["uplift"])
        sections += ["4. Non-renewal"]
        if values["noticePeriod"] is not None:
            if name == "amended-notice":
                sections.append("Original clause 4: Non-renewal notice must be given at least 30 calendar days before renewal.")
            elif name == "conflicting-notice":
                sections += ["Schedule A requires 30 calendar days of non-renewal notice before renewal.",
                             "Schedule B requires 60 calendar days of non-renewal notice before renewal. Both schedules are signed on the same date and neither states that it overrides the other."]
            else:
                sections.append("Non-renewal notice must be given at least " + values["noticePeriod"] + " " + values["noticeUnit"] + " before renewal.")
        if values["method"]:
            sections.append("Cancellation notice must be delivered by email" + (" to " + values["recipient"] if values["recipient"] else "") + ".")
        if values["timezone"]:
            sections.append("The contract time zone for dates and notices is " + values["timezone"] + ".")
        if values["conditions"] == "none":
            sections.append("There are no additional deadline conditions: no receipt requirement, time-of-day cutoff, business-day adjustment or exception applies.")
        elif values["conditions"]:
            sections.append("Additional notice deadline conditions: " + values["conditions"])
        sections += ["5. General", "Each party retains ownership of its pre-existing materials. Services and fees are governed by the provisions above. Signed for testing by the supplier and Acme Studio."]
        if name == "amended-notice":
            sections += ["6. Signed amendment", "This later signed amendment replaces original clause 4: Non-renewal notice must be given at least 60 calendar days before renewal. All other terms remain unchanged."]
        text = "\n\n".join(sections) + "\n"
        path = output / ("Notice-fixture-" + name + ".txt")
        path.write_text(text, encoding="utf-8")
        truth = {key: {"value": values[key], "status": "not_found" if values[key] is None else "extracted"} for key in keys}
        if name == "conflicting-notice":
            # Conflict descriptions may legitimately vary. Score detection, not
            # a prescribed sentence chosen by the fixture author.
            truth["noticePeriod"] = {"status": "conflicting"}
        result.append({"title": path.stem, "path": str(path), "kind": kind, "cohort": "regression", "split": "dev",
                       "value": truth, "evidence": {"_notice": {"reference_type": "authored_fixture", "scenario": name,
                           "review_note": "Expected facts written with this fictional source; not a human-labeled real-world sample."}}})
    return result
