import { describe, expect, test } from "bun:test"
import { translate } from "../../app/utils/locale"

describe("dashboard locale", () => {
  test("language selection changes the shell labels", () => {
    expect(translate("en", "overview")).toBe("Overview")
    expect(translate("zh-Hans", "overview")).toBe("总览")
  })

  test("session empty-state labels exist in every locale", () => {
    for (const locale of ["zh-Hant", "zh-Hans", "en"] as const) {
      expect(translate(locale, "noSessions")).not.toBe("noSessions")
      expect(translate(locale, "contextsDisabled")).not.toBe("contextsDisabled")
      expect(translate(locale, "unknownPath")).not.toBe("unknownPath")
      expect(translate(locale, "inputItems")).not.toBe("inputItems")
      expect(translate(locale, "outputItems")).not.toBe("outputItems")
    }
  })
})
