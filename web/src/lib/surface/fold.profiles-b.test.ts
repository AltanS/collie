import { describe } from "vitest";

import { profileCases, profileSuite } from "../../test/surface-fold";

// M56 spec 14: the profiles of omp and pi over their fixtures, the two slowest. The suite body is profileSuite.

describe.each(profileCases("omp", "pi"))("the $id profile over its fixtures (M56 spec 14)", profileSuite);
