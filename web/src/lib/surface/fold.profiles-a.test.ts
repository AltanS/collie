import { describe } from "vitest";

import { profileCases, profileSuite } from "../../test/surface-fold";

// M56 spec 14: the profiles of opencode, agy, grok and muse over their fixtures. The suite body is profileSuite.

describe.each(profileCases("opencode", "agy", "grok", "muse"))("the $id profile over its fixtures (M56 spec 14)", profileSuite);
