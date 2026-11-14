import { describe, expect, it } from "vitest";

import { parseRedumpDat } from "@/features/verification/redump";
import { RedumpSerialCatalog } from "@/integrations/redump/serial-catalog";

const index = parseRedumpDat(`clrmamepro (
\tname "Sony - PlayStation 2"
)
game (
\tname "Guitar Hero II (USA)"
\tregion "USA"
\tserial "SLUS-21447"
\trom ( name "Guitar Hero II (USA).iso" size 2 sha1 2222222222222222222222222222222222222222 )
)
`);

describe("RedumpSerialCatalog", () => {
  const loads: string[] = [];
  const catalog = new RedumpSerialCatalog({
    load: async (datName) => {
      loads.push(datName);
      return index;
    }
  });

  it("looks a PS2 game up in the PS2 list", async () => {
    const result = await catalog.lookup(8, ["Guitar Hero II"]);
    expect(loads).toEqual(["Sony - PlayStation 2"]);
    expect(result?.serials).toEqual(["SLUS-21447"]);
    expect(result?.gameFor("slus_214.47")).toBe("Guitar Hero II (USA)");
    expect(result?.gameFor("SLUS-99999")).toBeNull();
  });

  it("has nothing for platforms without a Redump list", async () => {
    expect(await catalog.lookup(130, ["Anything"])).toBeNull();
  });
});
