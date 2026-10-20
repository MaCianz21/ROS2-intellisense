/**
 * Shared constants. Kept free of `vscode` imports so it can be used from
 * pure modules and from unit tests running under plain Node.
 */

/** Must match `publisher` + `name` in package.json. */
export const EXTENSION_ID = 'macianz.ros2-intellisense';

/** Configuration section declared in package.json. */
export const CONFIG_SECTION = 'ros2IntelliSense';

/** Configuration section owned by the Microsoft C/C++ extension. */
export const CPPTOOLS_CONFIG_SECTION = 'C_Cpp';

/** Provider id reported to the C/C++ extension. */
export const PROVIDER_NAME = 'ROS 2 IntelliSense';
