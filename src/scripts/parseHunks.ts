import { parseHunksFromFile } from "../amigaHunkParser";
import { SourceAddressMapper } from "../sourceAddressMapper";

const prog = "/Users/batesgw1/vscode-amiga-wks-example-master/uae/dh0/gencop";

parseHunksFromFile(prog).then((hunks) => {
  console.dir(hunks, { depth: null });

  const mapper = new SourceAddressMapper(hunks, [10000]);
  console.log(
    mapper.locationToAddress(
      "/Users/batesgw1/vscode-amiga-wks-example-master/gencop.s",
      158
    )
  );

  console.log(mapper.addressToLocation(10406));
});
